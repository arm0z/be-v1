# Architecture

## Event Layer

```text
┌─ Content Script (per tab) ──────────────────────────────────────────────┐
│                                                                         │
│  ┌─ Bootstrap ───────────────────────────────────────────────────────┐  │
│  │  URL ──▶ Registry ──▶ first matching Route ──▶ route.build()      │  │
│  │                         [outlook?] [file?] [catch-all]            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                          │                                              │
│                          ▼                                              │
│  ┌─ Pipeline ────────────────────────────────────────────────────────┐  │
│  │                                                                   │  │
│  │   ┌─────┐    ┌─────────┐    ┌────────────┐    ┌───────┐           │  │
│  │   │ Tap │───▶│ Adapter │───▶│ Normalizer │───▶│ Relay │───────────┼──┼──▶ Service Worker
│  │   └─────┘    └─────────┘    └────────────┘    └───────┘           │  │
│  │     DOM        filter /       batch /          sendMessage /      │  │
│  │   events     inject / snap    dedup             port              │  │
│  │                                                                   │  │
│  │   ◀──────── Capture ────────▶                   ◀── Teardown ───▶ │  │
│  │   { type, ts, context, payload }                  () => void      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ SPA Observer (optional) ─────────────────────────────────────────┐  │
│  │  history.pushState / replaceState / popstate                      │  │
│  │  on URL change: if different Route → teardown() + route.build()   │  │
│  │                  if same Route    → pipeline stays alive          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

Lifecycle:
  Navigation  →  Chrome destroys context  →  re-injects  →  bootstrap()  →  new Pipeline
  SPA route   →  context survives  →  SPA Observer checks Route  →  rebuild only if different
```

### Event Layer Files

| File                                                                | Role                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/event/types.ts`](../src/event/types.ts)                       | Discriminated union type system. Defines `Capture` (content-script pipeline, 14 event types), `SessionEvent` (full stamped, 28 event types), shared target types (`ClickTarget`, `KeystrokeTarget`, `FormTarget`), per-layer payload interfaces, and pipeline types (`Tap`, `Adapter`, `Normalizer`, `Relay`, `Route`).                                                                                                          |
| [`src/event/tap.ts`](../src/event/tap.ts)                           | Base Tap. Hooks 14 DOM listeners (`keydown`, `compositionstart/update/end`, `click`, `auxclick`, `dblclick`, `contextmenu`, `scroll`, `selectionchange`, `copy`, `paste`, `focusin`, `change`, `submit`) via a single `AbortController`. Builds fully typed `Capture` payloads. Redacts sensitive fields (passwords, credit cards, SSNs).                                                                                        |
| [`src/event/adapters/html.ts`](../src/event/adapters/html.ts)       | HTML snapshot Adapter. Exports `SNAPSHOT_VIEWPORT` const and uses `SnapshotViewportPayload`. Injects periodic `snapshot.viewport` Captures every 60 s, deduped by content hash.                                                                                                                                                                                                                                                  |
| [`src/event/adapters/outlook.ts`](../src/event/adapters/outlook.ts) | Outlook Adapter. Filters out Captures from transient routes (e.g. email list between two emails).                                                                                                                                                                                                                                                                                                                                |
| [`src/event/adapters/file.ts`](../src/event/adapters/file.ts)       | File Adapter. Exports `FILE_CONTENT` const and `FileContentPayload`. Reads `file://` page text and emits a `file.content` Capture on pipeline start.                                                                                                                                                                                                                                                                             |
| [`src/event/normalizer.ts`](../src/event/normalizer.ts)             | Composable normalizer factory. Four individual normalizers: `keystrokeNormalizer` (batches printable keys, flushes after 1 s idle, flushes on IME composition start), `scrollNormalizer` (debounces 150 ms), `selectionNormalizer` (debounces 300 ms, drops empty), `formFocusNormalizer` (deduplicates rapid re-focus within same form). `normalizerFactory(opts)` composes them; `normalizer` is the default with all enabled. |
| [`src/event/relay.ts`](../src/event/relay.ts)                       | Terminal Relay. Forwards every Capture to the service worker via `chrome.runtime.sendMessage({ type: "capture", payload })`.                                                                                                                                                                                                                                                                                                     |
| [`src/event/registry.ts`](../src/event/registry.ts)                 | Route registry. Ordered list of `Route` objects — Outlook, file://, and a catch-all generic web pipeline. First match wins.                                                                                                                                                                                                                                                                                                      |
| [`src/event/spa-observer.ts`](../src/event/spa-observer.ts)         | SPA navigation observer. Monkey-patches `history.pushState`/`replaceState` and listens for `popstate` to detect client-side route changes.                                                                                                                                                                                                                                                                                       |
| [`src/event/dev.ts`](../src/event/dev.ts)                           | Dev logging utility. Structured `dev.log(channel, event, message, data)` — no-op in production (tree-shaken out), sends `{ type: "dev:log", entry }` to service worker in dev mode.                                                                                                                                                                                                                                              |
| [`src/content/main.ts`](../src/content/main.ts)                     | Content script bootstrap. Entry point injected on `<all_urls>`. Reads the URL, matches against the registry, builds the pipeline, and installs the SPA observer if needed.                                                                                                                                                                                                                                                       |
| [`src/background/main.ts`](../src/background/main.ts)               | Service worker. Receives `type: "capture"` messages, logs with source/tabId. In dev mode, runs the **DevHub**: receives `dev:log` messages, filters by channel/event, stores in 10k-entry ring buffer, broadcasts to connected dev pages via ports, and logs to the service worker console.                                                                                                                                      |

### Event Glossary

| Term           | What it is                                                                                                                                   | Type signature                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Capture**    | A single typed event record flowing through the content-script pipeline. Discriminated union on `type`.                                      | `{ type, ts, context, payload }`           |
| **Tap**        | The base layer. Hooks into the DOM and produces a stream of Captures. Returns a Teardown.                                                    | `(sink: (c: Capture) => void) => Teardown` |
| **Adapter**    | Domain-specific middleware. Wraps a Tap to inject, filter, or transform Captures (e.g. HTML snapshots, Outlook email parsing, file reading). | `(inner: Tap) => Tap`                      |
| **Normalizer** | Event-aggregation middleware. Wraps a Tap to deduplicate or batch Captures (e.g. keystroke batching). Same shape as Adapter.                 | `(inner: Tap) => Tap`                      |
| **Relay**      | Terminal layer. Wraps a Tap and forwards Captures to the service worker. Caps the chain.                                                     | `(inner: Tap) => Teardown`                 |
| **Teardown**   | A function that stops the pipeline and cleans up all resources.                                                                              | `() => void`                               |
| **Route**      | A URL pattern paired with a pipeline builder. The registry is an ordered list of Routes; first match wins.                                   | `{ match, build }`                         |
| **Registry**   | Ordered list of Routes. Consulted by the bootstrap on every page load.                                                                       | `Route[]`                                  |
| **Pipeline**   | A fully composed chain: `Tap → Adapter(s) → Normalizer → Relay → Teardown`.                                                                  | —                                          |

Adapter and Normalizer share the same signature (`Tap → Tap`), which is what makes them freely composable in any order and count. Relay caps the chain by collapsing it to just a Teardown.

---

### Event Overview

A tab gets opened, a Tap is attached to that tab. That Tap emits a `context: string` in each Capture — the context is an identifier within the tab, e.g. `"root"` by default, but sometimes a specific area like `"dashboard"`. The `source` of a Capture is `<context>@<tab_id>`, e.g. `root@123` or `dashboard@123`.

Each Tap can be wrapped with Adapters for domain-specific behavior — e.g. on a news site an HTML snapshot Adapter triggers periodically and emits `viewport.snapshot` Captures, on `file://` a file Adapter reads file contents, on Outlook an Outlook Adapter parses email views. These are modular and easily replaceable.

The chain is composed like so:

```typescript
const generic  = relay(normalizer(htmlAdapter(tap())))
const outlook  = relay(normalizer(outlookAdapter(tap())))
const file     = relay(normalizer(fileAdapter(tap())))
```

The Relay sends Captures to the service worker. The Normalizer aggregates events like keyboard typing into a single Capture. The whole chain produces a single Teardown that goes into a tab.

### Event Types — [`src/event/types.ts`](../src/event/types.ts)

Events are a discriminated union keyed on `type`. Two levels:

- **`BaseCapture<T, P>`** — content-script pipeline (no `tabId`/`windowId`/`source` yet): `{ type, ts, context, payload }`
- **`BaseEvent<T, P>`** — full stamped event (service worker adds `tabId`, `windowId`, `source`)
- **`Capture`** — union of `BaseCapture` variants (14 content-script event types)
- **`SessionEvent`** — union of `BaseEvent` variants (28 total event types, including service-worker-only events)

Shared target types: `KeystrokeTarget`, `ClickTarget`, `FormTarget`, `Bounds`, `FormFieldInfo`.

Events by layer:

| Layer         | Event types                                                                                                      | Source                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1. Session    | `window.created`, `window.closed`, `window.resized`, `tab.created`, `tab.closed`, `tab.moved`, `tab.transferred` | Service worker (`chrome.windows.*`, `chrome.tabs.*`)            |
| 2. Navigation | `nav.completed`, `nav.spa`, `nav.title_changed`                                                                  | Service worker (`chrome.webNavigation.*`)                       |
| 3. Attention  | `attention.active`, `attention.visible`, `attention.mouse_presence`, `attention.idle`                            | Service worker (`chrome.tabs.onActivated`, `chrome.idle.*`)     |
| 4. Keystrokes | `input.keystroke`, `input.composition`                                                                           | Content script (`keydown`, `composition*`)                      |
| 5. Mouse      | `input.click`, `input.double_click`, `input.context_menu`                                                        | Content script (`click`, `auxclick`, `dblclick`, `contextmenu`) |
| 6. Scroll     | `input.scroll`                                                                                                   | Content script (`scroll`)                                       |
| 7. Clipboard  | `input.selection`, `input.copy`, `input.paste`                                                                   | Content script (`selectionchange`, `copy`, `paste`)             |
| 8. Forms      | `input.form_focus`, `input.form_change`, `input.form_submit`                                                     | Content script (`focusin`, `change`, `submit`)                  |
| 9. Media      | `media.audio`, `media.download`                                                                                  | Service worker (`chrome.tabs.onUpdated`, `chrome.downloads.*`)  |
| 10. Snapshots | `snapshot.viewport`                                                                                              | HTML Adapter                                                    |
| Adapter       | `file.content`                                                                                                   | File Adapter                                                    |

```typescript
// ── Pipeline stages ─────────────────────────────────────────

type Teardown = () => void;
type Tap = (sink: (capture: Capture) => void) => Teardown;
type Adapter = (inner: Tap) => Tap;
type Normalizer = (inner: Tap) => Tap;
type Relay = (inner: Tap) => Teardown;
```

### Example: Generic HTML Pipeline — [`src/event/tap.ts`](../src/event/tap.ts) + [`src/event/adapters/html.ts`](../src/event/adapters/html.ts)

A Tap that hooks all DOM listeners via a single AbortController, wrapped with an Adapter that injects periodic HTML snapshots (deduped by content hash):

```typescript
/** Base Tap: attaches DOM listeners and streams all content-script Captures. */
function tap(context = "root"): Tap {
  return (sink) => {
    const ac = new AbortController();
    const { signal } = ac;
    const capture = { capture: true, signal } as const;
    const passive = { passive: true, signal } as const;

    document.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : null;
      sink({
        type: "input.click",
        ts: Date.now(),
        context,
        payload: { x: e.clientX, y: e.clientY, button: e.button, target: clickTarget(target) },
      });
    }, capture);

    document.addEventListener("keydown", (e) => { /* ... */ }, capture);
    document.addEventListener("scroll", () => { /* ... */ }, passive);
    // ... 14 DOM listeners total, all cleaned up by AbortController

    return () => ac.abort();
  };
}

/** Adapter: wraps any Tap and injects periodic HTML snapshots (deduped). */
const htmlAdapter: Adapter = (inner) => {
  return (sink) => {
    let lastHash: string | null = null;
    const teardownInner = inner(sink);

    // periodic snapshot, skipped if nothing changed
    const interval = setInterval(() => {
      const html = document.documentElement.outerHTML;
      const hash = simpleHash(html);
      if (hash === lastHash) return;
      lastHash = hash;
      sink({
        type: "snapshot.viewport",
        ts: Date.now(),
        context: "root",
        payload: {
          generator: "htmlAdapter",
          trigger: "mutation",
          url: window.location.href,
          title: document.title,
          viewport: { width: innerWidth, height: innerHeight, scrollY, scrollPercent },
          content: html,
        } satisfies SnapshotViewportPayload,
      });
    }, 60_000);

    return () => {
      clearInterval(interval);
      teardownInner();
    };
  };
};
```

Usage — the full generic web pipeline (composed in [`src/event/registry.ts`](../src/event/registry.ts)):

```typescript
const teardown = relay(normalizer(htmlAdapter(tap())));
```

The Adapter calls `inner(sink)` to pass the sink through, then adds its own Captures on the same sink. This is the core pattern: every Adapter/Normalizer receives a sink, forwards it inward, and optionally injects or transforms on the way out.

### Example: Filtering (Outlook Adapter) — [`src/event/adapters/outlook.ts`](../src/event/adapters/outlook.ts)

Because the Adapter wraps the sink, it has full control over what gets forwarded — it can drop, buffer, delay, or transform any Capture. This is useful for SPAs where intermediate routes (e.g. a list view between two emails) shouldn't emit events.

Consider Outlook navigating: `/mail/id1` → `/mail/` → `/mail/id2`. The middle URL is the email list — transient, not interesting. The Adapter can gate on the current URL:

```typescript
/** Adapter: filters out transient routes, only forwards events on specific email views. */
const outlookAdapter: Adapter = (inner) => {
  return (sink) => {
    const isEmailView = () =>
      /\/mail\//.test(window.location.pathname) &&
      window.location.pathname !== "/mail/";

    const teardownInner = inner((capture) => {
      if (!isEmailView()) {
        dev.log("adapter", "filtered", "dropped capture (transient route)", { type: capture.type });
        return;
      }
      sink(capture);
    });

    return teardownInner;
  };
};
```

This works because SPA navigation doesn't rebuild the pipeline (same Route matches), so the Adapter stays alive across all three URL changes. The Tap underneath keeps firing DOM events — the Adapter just decides which ones reach the sink.

The same pattern applies to any filtering logic: ignore certain event types, suppress events during loading states, throttle high-frequency events, etc. The sink is just a callback — intercepting it is the entire mechanism.

### Pipeline Memory

Pipeline state is just `let` variables inside the closure that a Tap, Adapter, or Normalizer creates when it starts. This state is:

- **Created** when the pipeline is built (`route.build()`)
- **Alive** for the lifetime of the page — across ticks, intervals, and event callbacks
- **Destroyed** when the page navigates (Chrome kills the entire content script context) or when the Teardown is called (SPA route change)

This is the right default. Most pipeline state — last clicked element, keystroke buffer, previous snapshot hash, scroll debounce position — only makes sense within the current page. After navigation the DOM is different, so the old state is meaningless.

```text
Page A loads  →  bootstrap()  →  closures created  →  state accumulates
Page A unloads  →  Chrome destroys context  →  all state gone
Page B loads  →  bootstrap()  →  fresh closures  →  state starts from zero
```

For state that *does* need to survive across navigations (e.g. "pages visited this session", "total idle time"), that belongs in the **service worker** or `chrome.storage.session` — not in the pipeline. The pipeline is per-page; the service worker is per-session.

### Injection & Lifecycle — [`src/content/main.ts`](../src/content/main.ts)

A single content script is injected on `<all_urls>` via the manifest. It acts as a thin bootstrap: read the URL, match it against the Registry, assemble the right Pipeline, start it.

**On normal navigation** (user clicks a link, types a URL, etc.), Chrome destroys the entire content script context — all JS state, DOM listeners, timers, everything. Then it re-injects the content script on the new page. The bootstrap runs again, matches the new URL, and builds a fresh Pipeline. There is no manual teardown or replacement — Chrome handles the lifecycle.

**On SPA navigation** (Outlook, Gmail, etc. use History API pushState/replaceState without a real page load), Chrome does *not* re-inject. The content script context survives. For these, the bootstrap installs a URL observer that detects route changes. The pipeline is only torn down and rebuilt if the new URL matches a *different* Route. Navigating within the same SPA (e.g. Outlook inbox → email → calendar) keeps the same pipeline and its closure state alive.

Registry → [`src/event/registry.ts`](../src/event/registry.ts), Bootstrap → [`src/content/main.ts`](../src/content/main.ts), SPA Observer → [`src/event/spa-observer.ts`](../src/event/spa-observer.ts)

```typescript
// ── Route & Registry ────────────────────────────────────────

type Route = {
  match: (url: string) => boolean;
  build: () => Teardown;
};

/** Ordered list. First match wins. Last entry is the catch-all. */
const registry: Route[] = [
  {
    match: (url) => /outlook\.(com|live\.com)/.test(url),
    build: () => relay(normalizer(outlookAdapter(tap()))),
  },
  {
    match: (url) => url.startsWith("file://"),
    build: () => relay(normalizer(fileAdapter(tap()))),
  },
  {
    // catch-all: generic web
    match: () => true,
    build: () => relay(normalizer(htmlAdapter(tap()))),
  },
];

// ── Bootstrap (content script entry point) ──────────────────

function bootstrap(): void {
  const url = window.location.href;
  const route = registry.find((r) => r.match(url));
  if (!route) return;

  let teardown = route.build();
  let currentRoute = route;

  // SPA navigation: only rebuild if the matched Route changes
  if (needsSpaObserver(url)) {
    observeSpaNavigation((newUrl) => {
      const next = registry.find((r) => r.match(newUrl));
      if (next && next !== currentRoute) {
        teardown();
        currentRoute = next;
        teardown = next.build();
      }
    });
  }
}

bootstrap();
```

The SPA observer monkey-patches `history.pushState`/`replaceState` and listens for `popstate`, which fires exactly on route changes:

```typescript
function observeSpaNavigation(onNavigate: (url: string) => void): void {
  const original = history.pushState.bind(history);
  history.pushState = (...args) => {
    original(...args);
    onNavigate(window.location.href);
  };
  const originalReplace = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    originalReplace(...args);
    onNavigate(window.location.href);
  };
  window.addEventListener("popstate", () => onNavigate(window.location.href));
}
```

## Aggregation Layer

```text
┌─ Service Worker ────────────────────────────────────────────────────────┐
│                                                                         │
│  Captures arrive via chrome.runtime.onMessage                           │
│                          │                                              │
│                          ▼                                              │
│  ┌─ Aggregator ────────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │   activeSource: "root@42"                                           ││
│  │   openBundle:   { source, startedAt, captures: [...] }              ││
│  │   sealed:       Bundle[]                                            ││
│  │                                                                     ││
│  │   on Capture ──▶ append to openBundle                               ││
│  │   on focus shift ──▶ seal openBundle, translate(), record edge,     ││
│  │                      open new                                       ││
│  │                                                                     ││
│  └──────────────────────────┬──────────────────────────────────────────┘│
│                             │                                           │
│                             ▼                                           │
│  ┌─ Navigation Graph ──────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │   Nodes: sources (including "unknown")                              ││
│  │   Edges: directed, weighted by transition count                     ││
│  │                                                                     ││
│  │   root@42 ──3──▶ root@17 ──1──▶ unknown ──2──▶ root@42              ││
│  │       │                            ▲                                ││
│  │       └──────────────1─────────────┘                                ││
│  │                                                                     ││
│  └──────────────────────────┬──────────────────────────────────────────┘│
│                             │                                           │
│                             ▼                                           │
│  ┌─ Grouper ───────────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │   on sync trigger:                                                  ││
│  │     1. partition graph into Groups (community detection)            ││
│  │     2. assign each sealed Bundle to its source's Group              ││
│  │     3. collect Groups + Bundles into Packet                         ││
│  │     4. send Packet to server                                        ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Aggregation Glossary

| Term               | What it is                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **StampedCapture** | A Capture with `tabId` and `source` stamped on by the service worker. The content script doesn't know its tab ID — the service worker reads it from `sender.tab.id` and computes `source` as `context@tabId`.     |
| **Bundle**         | A collection of StampedCaptures from a single source during a single continuous focus span. Opened when a source gains focus, sealed when focus shifts away. On seal, `translate()` renders captures into `text`. |
| **Translate**      | A function `(bundles: Bundle[]) => string` that renders Bundles into a single human/LLM-readable text stream. Runs on seal. Each Bundle stores the result in its `text` field.                                    |
| **Edge**           | A directed, weighted connection between two sources in the navigation graph. Weight increments each time the user transitions from one source to another.                                                         |
| **`"unknown"`**    | The off-browser source. A regular node in the graph with `source: "unknown"`. Has no Bundle (nothing to capture), but edges connect to and from it so the graph knows when the user left and returned.            |
| **Group**          | A cluster of related sources discovered by partitioning the navigation graph (community detection). Sources that the user frequently navigates between end up in the same Group.                                  |
| **Packet**         | The delivery unit. Contains Groups, each with its associated Bundles, plus the navigation graph edges. Sent to the server on sync.                                                                                |

### Aggregation Overview

The Aggregation Layer lives in the service worker. It has two responsibilities:

**1. Bundling** — receives Captures from the Event Layer and groups them into Bundles by source and focus span.

- A **Bundle** is open for exactly one source at a time — the one the user is currently focused on.
- When focus shifts (tab switch, browser blur, window change), the current Bundle is **sealed**, `translate()` renders its captures into the `text` field, and a new Bundle is opened for the newly focused source.
- When the user leaves the browser entirely, the current Bundle is sealed and the active source becomes `"unknown"`. No Bundle is opened for it — there's nothing to capture. When the user returns, a new Bundle opens for the source they return to.

**2. Translation** — on seal, `translate([bundle])` converts the Bundle's captures into a single plain-text stream stored in `bundle.text`. This is the LLM-readable representation of the user's activity during that focus span. The translate function takes `Bundle[]` so it can also be called on a group of Bundles to produce a combined narrative.

**3. Navigation graph** — alongside bundling, every focus shift records a directed edge in a weighted graph.

- Nodes are sources (including `"unknown"`).
- Each transition `A → B` increments the weight of edge `(A, B)`.
- On sync, the graph is partitioned into **Groups** using community detection. Sources the user frequently navigates between cluster together.
- Each sealed Bundle is assigned to its source's Group.
- The result is a **Packet**: a list of Groups, each containing its Bundles, plus the graph edges.

### Aggregation Types

```typescript
/**
 * The service worker stamps tabId and source onto each Capture
 * when it receives it. The content script doesn't know its own tabId —
 * it comes from sender.tab.id in chrome.runtime.onMessage.
 */
type StampedCapture = Capture & {
  tabId: string;         // e.g. "42"
  source: string;        // computed: `${context}@${tabId}`, e.g. "root@42"
};

type Bundle = {
  source: string;        // e.g. "root@42", "dashboard@42"
  startedAt: number;
  endedAt: number | null; // null while open, set on seal
  captures: StampedCapture[];
  text: string | null;   // null while open, set by translate() on seal
};

/**
 * Translates sealed Bundles into a single human/LLM-readable text stream.
 * Runs once per seal. The output is a plain text rendering of the captures
 * in chronological order — e.g. timestamps, click targets, typed text,
 * navigation events, snapshot summaries.
 */
type Translate = (bundles: Bundle) => string;

const UNKNOWN = "unknown";

type Edge = {
  from: string;          // source id, e.g. "root@42", "unknown"
  to: string;            // source id, e.g. "root@17", "unknown"
  weight: number;        // number of transitions
};

type Group = {
  id: string;
  bundles: Bundle[];
  text: string;
  meta: GroupMeta;       // computed when the group is assembled
};

/** Computed from the group's bundles. */
type GroupMeta = {
  sources: string[];     // unique source ids in this group
  tabs: string[];        // unique tabIds across all bundles
  timeRange: {
    start: number;       // earliest bundle startedAt
    end: number;         // latest bundle endedAt
  };
};

type Packet = {
  id: string;
  groups: Group[];
  edges: Edge[];
  createdAt: number;
};
```

### Example: Translate output

Given a Bundle with click, typing, and snapshot captures, `translate()` produces something like:

```text
[10:32:05] navigated to https://github.com/org/repo/pulls
[10:32:08] clicked "Files changed" tab
[10:32:12] scrolled
[10:32:15] typed "looks good, one nit on line 42"
[10:32:20] clicked "Submit review"
[10:33:05] snapshot: PR #138 — review submitted, 3 files changed
```

The exact format is up to the translate implementation. The point is: raw captures in, readable text out.

### Example: Service Worker Aggregator

```typescript
let openBundle: Bundle | null = null;
let activeSource: string | null = null;
const sealed: Bundle[] = [];
const edges: Map<string, Edge> = new Map(); // key: "from -> to"

// ── Receive Captures from the Event Layer ───────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== "capture") return;
  const capture: Capture = msg.payload;
  const tabId = String(sender.tab?.id ?? "unknown");
  const source = `${capture.context}@${tabId}`;

  // stamp tabId and source onto the capture
  const stamped: StampedCapture = { ...capture, tabId, source };

  if (!openBundle || openBundle.source !== source) {
    transition(source);
  }

  openBundle!.captures.push(stamped);
});

// ── Focus shifts ────────────────────────────────────────────

chrome.tabs.onActivated.addListener((info) => {
  // tab switched — we'll learn the real source when the first Capture arrives,
  // but we seal the current bundle now
  seal();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // user left the browser
    transition(UNKNOWN);
  }
});

// ── Core: transition between sources ────────────────────────

function transition(to: string): void {
  const from = activeSource;
  seal();

  // record edge
  if (from !== null) {
    const key = `${from}→${to}`;
    const existing = edges.get(key);
    if (existing) {
      existing.weight++;
    } else {
      edges.set(key, { from, to, weight: 1 });
    }
  }

  activeSource = to;

  // don't open a bundle for unknown — nothing to capture
  if (to !== UNKNOWN) {
    openBundle = { source: to, startedAt: Date.now(), endedAt: null, captures: [], text: null };
  }
}

function seal(): void {
  if (!openBundle) return;
  openBundle.endedAt = Date.now();
  openBundle.text = translate([openBundle]);
  sealed.push(openBundle);
  openBundle = null;
}

// ── Sync: partition graph, build packet ─────────────────────

function flush(): Packet {
  seal();

  const allEdges = [...edges.values()];
  const groups = partitionIntoGroups(allEdges, sealed);

  const packet: Packet = {
    groups,
    edges: allEdges,
    createdAt: Date.now(),
  };

  // reset for next session
  sealed.length = 0;
  edges.clear();

  return packet;
}

/** Community detection over the navigation graph. Implementation TBD. */
function partitionIntoGroups(edges: Edge[], bundles: Bundle[]): Group[] {
  // e.g. directed Louvain, label propagation, etc.
  // assigns each source to a group, then maps bundles to their source's group
  throw new Error("not implemented");
}
```

The service worker doesn't know or care which pipeline produced the Captures. The Event Layer handles *what* gets captured; the Aggregation Layer handles *how it's grouped and related*.

## Syncing Layer

```text
┌─ Service Worker ────────────────────────────────────────────────────────┐
│                                                                         │
│  Aggregation Layer calls sync(packet)                                   │
│                          │                                              │
│                          ▼                                              │
│  ┌─ Sender ────────────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │   POST /api/v1/extension/sync                                       ││
│  │   Authorization: Bearer <token>                                     ││
│  │   Body: Packet                                                      ││
│  │                                                                     ││
│  │   on success ──▶ done                                               ││
│  │   on failure ──▶ push to RetryQueue                                 ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ RetryQueue ────────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │   Persisted in chrome.storage.local                                 ││
│  │   Retries with exponential backoff                                  ││
│  │   Drops entries older than maxAge                                   ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Syncing Overview

The Syncing Layer takes a Packet and sends it to the server. Something upstream (session management, manual trigger, etc.) decides *when* to flush — this layer just handles delivery and retry.

- `POST /api/v1/extension/sync` with `Authorization: Bearer <token>` and the Packet as the JSON body.
- On success, done.
- On failure (network error, 5xx, etc.), the Packet is pushed to a **RetryQueue** persisted in `chrome.storage.local`. Retries with exponential backoff, drops entries older than a max age.

### Syncing Types

```typescript
type SyncConfig = {
  syncUrl: string;       // "/api/v1/extension/sync"
  retryMaxAge: number;   // e.g. 7 days (ms)
};
```

### Example: Sender

```typescript
async function sync(packet: Packet): Promise<void> {
  try {
    const token = await getAuthToken();
    const res = await fetch(config.syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(packet),
    });
    if (!res.ok) throw new Error(`${res.status}`);
  } catch {
    await pushToRetryQueue(packet);
  }
}
```

## Persistence Layer

```text
┌─ chrome.storage.local ──────────────────────────────────────────────────┐
│                                                                         │
│  ┌─ Checkpoint: Aggregator State ──────────────────────────────────────┐│
│  │  key: "checkpoint"                                                  ││
│  │  value: { openBundle, sealed[], edges, activeSource, savedAt }      ││
│  │  written: every N events or every M seconds                         ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ RetryQueue ────────────────────────────────────────────────────────┐│
│  │  key: "retryQueue"                                                  ││
│  │  value: Packet[]                                                    ││
│  │  written: on sync failure                                           ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

Recovery points:
  1. Service worker killed mid-session → restarts → reads checkpoint → resumes
  2. Browser closed abruptly → reopens → reads checkpoint → flushes as Packet → syncs
  3. Sync failed → Packet in RetryQueue → retried on next startup
```

### Persistence Overview

Chrome can kill the service worker at any time (idle timeout, update, crash). The browser itself can close without warning. The Persistence Layer ensures no data is silently lost by checkpointing the Aggregator's in-memory state to `chrome.storage.local`.

**What gets persisted:**

- The open Bundle (if any)
- All sealed Bundles not yet flushed
- The navigation graph edges
- The active source

**When it gets persisted (checkpointing):**

- Every N events (e.g. every 50 Captures)
- Every M seconds (e.g. every 30 seconds) via `chrome.alarms`
- On `chrome.runtime.onSuspend` (Chrome signals the service worker is about to be killed — best-effort, not guaranteed)

**Recovery scenarios:**

1. **Service worker restarts** (killed by Chrome, extension updated, etc.) — on startup, read the checkpoint from `chrome.storage.local`. Restore `openBundle`, `sealed[]`, `edges`, `activeSource`. Resume as if nothing happened. Events that arrived between the last checkpoint and the kill are lost — this is an acceptable trade-off for simplicity.

2. **Browser closed abruptly** (crash, force quit, shutdown) — on next browser launch, the service worker starts, reads the checkpoint. The stale open Bundle is sealed (its `endedAt` set to `savedAt`). All sealed Bundles are flushed into a Packet and synced. This Packet represents the tail end of the previous session.

3. **Sync failure** — the Packet goes to the RetryQueue (already in `chrome.storage.local`). On startup, the RetryQueue is drained before normal operation resumes.

### Persistence Types

```typescript
type Checkpoint = {
  openBundle: Bundle | null;
  sealed: Bundle[];
  edges: Edge[];
  activeSource: string | null;
  savedAt: number;
};
```

### Example: Checkpointing

```typescript
let eventsSinceCheckpoint = 0;
const CHECKPOINT_INTERVAL = 50; // events

/** Called by the Aggregator after every incoming event. */
function maybeCheckpoint(): void {
  eventsSinceCheckpoint++;
  if (eventsSinceCheckpoint >= CHECKPOINT_INTERVAL) {
    checkpoint();
  }
}

async function checkpoint(): Promise<void> {
  eventsSinceCheckpoint = 0;
  const data: Checkpoint = {
    openBundle,
    sealed: [...sealed],
    edges: [...edges.values()],
    activeSource,
    savedAt: Date.now(),
  };
  await chrome.storage.local.set({ checkpoint: data });
}

/** Called on service worker startup. */
async function recover(): Promise<void> {
  // drain retry queue first
  await drainRetryQueue();

  const stored = await chrome.storage.local.get("checkpoint");
  const cp: Checkpoint | undefined = stored.checkpoint;
  if (!cp) return;

  // restore state
  activeSource = cp.activeSource;
  sealed.push(...cp.sealed);
  for (const edge of cp.edges) {
    edges.set(`${edge.from}→${edge.to}`, edge);
  }

  if (cp.openBundle) {
    // seal the stale open bundle — we don't know when it actually ended,
    // so use the checkpoint timestamp as best estimate
    cp.openBundle.endedAt = cp.savedAt;
    sealed.push(cp.openBundle);
  }

  // if there are sealed bundles from a previous session, flush them now
  if (sealed.length > 0) {
    const packet = flush();
    await sync(packet);
  }

  // clear the checkpoint
  await chrome.storage.local.remove("checkpoint");
}
```

### Periodic checkpoint via chrome.alarms

`setTimeout` and `setInterval` do not survive service worker restarts. Use `chrome.alarms` for the periodic checkpoint:

```typescript
chrome.alarms.create("checkpoint", { periodInMinutes: 0.5 }); // every 30 seconds

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkpoint") {
    checkpoint();
  }
});
```

## Development Layer

```text
┌─ Content Scripts ────────────┐     ┌─ Service Worker ──────────────────┐
│                              │     │                                   │
│  Tap / Adapter / Normalizer  │     │  Aggregator / Graph / Sync        │
│       │                      │     │       │                           │
│       ▼                      │     │       ▼                           │
│  dev.log(channel, data) ─────┼────▶│  DevHub                           │
│                              │     │    │                              │
└──────────────────────────────┘     │    ├─ filter (channel on/off)     │
                                     │    ├─ ring buffer (last N logs)   │
                                     │    ├─ live state snapshot         │
                                     │    │    openBundle                │
                                     │    │    sealed[]                  │
                                     │    │    edges (graph)             │
                                     │    │    activeSource              │
                                     │    │                              │
                                     │    └─ broadcast to connected      │
                                     │       dev page via port           │
                                     │                                   │
                                     └────────────┬──────────────────────┘
                                                  │
                                                  ▼
                                     ┌─ dev.html ───────────────────────┐
                                     │                                  │
                                     │  connects via chrome.runtime     │
                                     │  .connect({ name: "dev" })       │
                                     │                                  │
                                     │  ┌─ Log stream ───────────────┐  │
                                     │  │  filterable by channel     │  │
                                     │  └────────────────────────────┘  │
                                     │  ┌─ Graph view ───────────────┐  │
                                     │  │  nodes, edges, weights     │  │
                                     │  │  updates live              │  │
                                     │  └────────────────────────────┘  │
                                     │  ┌─ State inspector ──────────┐  │
                                     │  │  active source, bundles,   │  │
                                     │  │  sealed count, checkpoint  │  │
                                     │  └────────────────────────────┘  │
                                     │  ┌─ Filter toggles ───────────┐  │
                                     │  │  per-channel on/off        │  │
                                     │  └────────────────────────────┘  │
                                     │                                  │
                                     └──────────────────────────────────┘

In production: dev.log is a no-op, tree-shaken out. DevHub never runs. Zero cost.
```

### Development Overview

Every layer calls `dev.log(channel, data)` to emit structured log entries. In production this is a no-op. In dev mode (`import.meta.env.DEV`), logs flow to a central **DevHub** in the service worker which filters, buffers, and broadcasts them to a **dev page** (`dev.html`).

The dev page is a regular extension page (`chrome-extension://<id>/dev.html`) that connects to the service worker via `chrome.runtime.connect`. It receives a live stream of filtered logs plus full state snapshots (graph, bundles, active source). No devtools API needed — just open the page in a tab.

### Development Types

```typescript
type DevChannel =
  | "tap"            // raw DOM events from the Tap
  | "adapter"        // Adapter injections/filters
  | "normalizer"     // Normalizer batching decisions
  | "relay"          // Captures sent to service worker
  | "aggregator"     // bundle open/seal/transition
  | "graph"          // edge added/updated
  | "sync"           // packet sent/failed/retried
  | "persistence"    // checkpoint written/restored
  ;

type DevEntry = {
  channel: DevChannel;
  event?: string;        // e.g. "click", "keydown", "viewport.snapshot", "seal", "transition"
  timestamp: number;
  source?: string;       // which source produced this, if applicable
  message: string;
  data?: unknown;
};

/** Two-level filter: channel on/off, then per-event on/off within a channel. */
type DevFilter = {
  channels: Record<DevChannel, boolean>;
  events: Record<string, boolean>;  // e.g. { "click": true, "scroll": false, "keydown": true }
};

type DevSnapshot = {
  activeSource: string | null;
  openBundle: { source: string; captureCount: number } | null;
  sealedCount: number;
  edges: Edge[];
  filter: DevFilter;
};

/** Messages from DevHub → dev page. */
type DevMessage =
  | { type: "entry"; entry: DevEntry }
  | { type: "snapshot"; snapshot: DevSnapshot }
  | { type: "filter"; filter: DevFilter }
  ;

/** Messages from dev page → DevHub. */
type DevCommand =
  | { type: "setChannelFilter"; channels: Partial<Record<DevChannel, boolean>> }
  | { type: "setEventFilter"; events: Partial<Record<string, boolean>> }
  | { type: "requestSnapshot" }
  ;
```

### Example: dev.log — [`src/event/dev.ts`](../src/event/dev.ts)

```typescript
// ── dev.ts (imported everywhere) ────────────────────────────

function createDevLog() {
  if (!import.meta.env.DEV) {
    // no-op in production — tree-shaken out
    return (_channel: DevChannel, _event: string, _message: string, _data?: unknown) => {};
  }

  return (channel: DevChannel, event: string, message: string, data?: unknown) => {
    const entry: DevEntry = {
      channel,
      event,
      timestamp: Date.now(),
      message,
      data,
    };

    // content script → service worker
    chrome.runtime.sendMessage({ type: "dev:log", entry });
  };
}

export const dev = { log: createDevLog() };
```

Usage in a Tap:

```typescript
function tap(context = "root"): Tap {
  return (sink) => {
    document.addEventListener("click", (e) => {
      const cap: Capture = {
        type: "input.click",
        ts: Date.now(),
        context,
        payload: { x: e.clientX, y: e.clientY, button: e.button, target: clickTarget(e.target) },
      };
      dev.log("tap", "input.click", "click event", cap);
      sink(cap);
    }, capture);
    // ... 14 listeners total
  };
}
```

Usage in the Aggregator:

```typescript
function transition(to: string): void {
  const from = activeSource;
  dev.log("aggregator", "transition", `${from} → ${to}`);
  seal();
  // ...
  dev.log("graph", "edge", `${from} → ${to}`, { weight: edge.weight });
}
```

### Example: DevHub (service worker)

```typescript
// ── Only runs in dev mode ───────────────────────────────────

if (import.meta.env.DEV) {
  const LOG_BUFFER_SIZE = 10_000;
  const logs: DevEntry[] = [];
  const ports: Set<chrome.runtime.Port> = new Set();

  let filter: DevFilter = {
    channels: {
      tap: true,
      adapter: true,
      normalizer: true,
      relay: false,       // noisy, off by default
      aggregator: true,
      graph: true,
      sync: true,
      persistence: true,
    },
    events: {},           // empty = all events allowed; set "scroll": false to suppress
  };

  // receive logs from content scripts
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "dev:log") return;
    receive(msg.entry);
  });

  // service worker calls this directly
  function devLog(channel: DevChannel, event: string, message: string, data?: unknown): void {
    receive({ channel, event, timestamp: Date.now(), message, data });
  }

  function receive(entry: DevEntry): void {
    // two-level filter: channel first, then event
    if (!filter.channels[entry.channel]) return;
    if (entry.event && filter.events[entry.event] === false) return;

    logs.push(entry);
    if (logs.length > LOG_BUFFER_SIZE) logs.shift();

    for (const port of ports) {
      port.postMessage({ type: "entry", entry } satisfies DevMessage);
    }
  }

  // dev page connects
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "dev") return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));

    // send current state
    port.postMessage({ type: "snapshot", snapshot: buildSnapshot() } satisfies DevMessage);
    port.postMessage({ type: "filter", filter } satisfies DevMessage);

    // receive commands from dev page
    port.onMessage.addListener((msg: DevCommand) => {
      if (msg.type === "setChannelFilter") {
        filter.channels = { ...filter.channels, ...msg.channels };
        broadcast({ type: "filter", filter });
      }
      if (msg.type === "setEventFilter") {
        filter.events = { ...filter.events, ...msg.events };
        broadcast({ type: "filter", filter });
      }
      if (msg.type === "requestSnapshot") {
        port.postMessage({ type: "snapshot", snapshot: buildSnapshot() } satisfies DevMessage);
      }
    });

    function broadcast(msg: DevMessage): void {
      for (const p of ports) p.postMessage(msg);
    }
  });

  function buildSnapshot(): DevSnapshot {
    return {
      activeSource,
      openBundle: openBundle
        ? { source: openBundle.source, captureCount: openBundle.captures.length }
        : null,
      sealedCount: sealed.length,
      edges: [...edges.values()],
      filter,
    };
  }
}
```
