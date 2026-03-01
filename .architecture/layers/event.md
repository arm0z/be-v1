# Event Layer

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
│  │     DOM        filter /       consume /          port             │  │
│  │   events     inject / snap   batch / dedup                        │  │
│  │                                                                   │  │
│  │   ◀──────── Capture ────────▶                   ◀── Teardown ───▶ │  │
│  │   { type, timestamp, context, payload }             () => void    │  │
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

## Event Layer Files

| File                                                                | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/event/types.ts`](../../src/event/types.ts)                       | Discriminated union type system. Defines `Capture` (content-script pipeline, 15 event types), `SessionEvent` (full stamped, 31 event types), shared target types (`ClickTarget`, `KeystrokeTarget`, `FormTarget`), per-layer payload interfaces, and pipeline types (`Tap`, `Adapter`, `Normalizer`, `Relay`, `Route`).                                                                                                                                                                                                                                                                                               |
| [`src/event/tap.ts`](../../src/event/tap.ts)                           | Base Tap. Hooks 14 DOM listeners (`keydown`, `compositionstart/update/end`, `click`, `auxclick`, `dblclick`, `contextmenu`, `scroll`, `selectionchange`, `copy`, `paste`, `focusin`, `change`, `submit`) via a single `AbortController`. Builds fully typed `Capture` payloads. Redacts sensitive fields (passwords, credit cards, SSNs).                                                                                                                                                                                                                                                                             |
| [`src/event/adapters/html.ts`](../../src/event/adapters/html.ts)       | HTML content Adapter. Exports `HTML_CONTENT` const and uses `HTMLContentPayload`. Injects event-driven `html.content` Captures on navigation, significant scroll (≥ 50% viewport), and DOM mutations (dialogs, large content changes). Deduped by content hash, debounced 500 ms, cooldown 2 s. See [html adapter docs](../adapters/html.md).                                                                                                                                                                                                                                                                        |
| [`src/event/adapters/outlook.ts`](../../src/event/adapters/outlook.ts) | Outlook Adapter. Filters out Captures from transient routes (e.g. email list between two emails).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [`src/event/adapters/file.ts`](../../src/event/adapters/file.ts)       | File Adapter. Exports `FILE_CONTENT` const and `FileContentPayload`. Categorizes files by extension (text, markup, image, audio, video, pdf, binary), extracts text content (including PDF via `pdfjs-dist`), truncates at 65 KB, and emits a `file.content` Capture on pipeline start. See [file adapter docs](../adapters/file.md).                                                                                                                                                                                                                                                                                 |
| [`src/event/normalizer.ts`](../../src/event/normalizer.ts)             | Composable normalizer factory. Normalizers **consume** the events they handle — raw events never pass through to the Relay. Four individual normalizers: `keystrokeNormalizer` (consumes `input.keystroke` and `input.composition`, batches printable keys into `input.keystroke_batch` after 1 s idle), `scrollNormalizer` (debounces `input.scroll` at 150 ms), `selectionNormalizer` (debounces `input.selection` at 300 ms, drops empty), `formFocusNormalizer` (strips form snapshot on rapid re-focus within same form). `normalizerFactory(opts)` composes them; `normalizer` is the default with all enabled. |
| [`src/event/relay.ts`](../../src/event/relay.ts)                       | Terminal Relay. Forwards every Capture to the service worker via a persistent `chrome.runtime.connect({ name: "capture" })` port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [`src/event/visibility.ts`](../../src/event/visibility.ts)             | Visibility tracker. Runs in every content script (outside the pipeline). Listens for `visibilitychange`, `window.focus`, `window.blur`, and `pageshow` (bfcache restore). Sends `{ type: "page:visibility", visible, url, title }` to the service worker via `chrome.runtime.sendMessage`. Deduplicates with `lastState` tracking. Reports initial state on load. All three signals are needed: `visibilitychange` for tab switches, `focus`/`blur` for multi-window and alt-tab detection.                                                                                                                           |
| [`src/event/registry.ts`](../../src/event/registry.ts)                 | Route registry. Ordered list of `Route` objects — Outlook, file://, and a catch-all generic web pipeline. First match wins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [`src/event/spa-observer.ts`](../../src/event/spa-observer.ts)         | SPA navigation observer. Monkey-patches `history.pushState`/`replaceState` and listens for `popstate` to detect client-side route changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [`src/event/dev.ts`](../../src/event/dev.ts)                           | Dev logging utility. Structured `dev.log(channel, event, message, data)` — no-op in production (tree-shaken out), sends `{ type: "dev:log", entry }` to service worker in dev mode.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [`src/content/main.ts`](../../src/content/main.ts)                     | Content script bootstrap. Entry point injected on `<all_urls>`. Calls `setupVisibility()` first (runs on every tab regardless of route), then matches the URL against the registry, builds the pipeline, and installs the SPA observer if needed.                                                                                                                                                                                                                                                                                                                                                                     |
| [`src/background/main.ts`](../../src/background/main.ts)               | Service worker. Receives Captures via `chrome.runtime.onConnect` port (`name: "capture"`), logs with source/tabId. Listens to Chrome APIs for session, navigation, attention, and media events. In dev mode, runs the **DevHub**: receives `dev:log` messages from content scripts, overrides `dev.log` to call `receive()` directly (no sendMessage round-trip), filters by channel/event, stores in 10k-entry ring buffer, broadcasts to connected dev pages via ports.                                                                                                                                             |

## Event Glossary

| Term           | What it is                                                                                                                                          | Type signature                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Capture**    | A single typed event record flowing through the content-script pipeline. Discriminated union on `type`.                                             | `{ type, timestamp, context, payload }`    |
| **Tap**        | The base layer. Hooks into the DOM and produces a stream of Captures. Returns a Teardown.                                                           | `(sink: (c: Capture) => void) => Teardown` |
| **Adapter**    | Domain-specific middleware. Wraps a Tap to inject, filter, or transform Captures (e.g. HTML snapshots, Outlook email parsing, file reading).        | `(inner: Tap) => Tap`                      |
| **Normalizer** | Event-aggregation middleware. Wraps a Tap to consume, deduplicate, or batch Captures. Consumed events never reach the Relay. Same shape as Adapter. | `(inner: Tap) => Tap`                      |
| **Relay**      | Terminal layer. Wraps a Tap and forwards Captures to the service worker. Caps the chain.                                                            | `(inner: Tap) => Teardown`                 |
| **Teardown**   | A function that stops the pipeline and cleans up all resources.                                                                                     | `() => void`                               |
| **Route**      | A URL pattern paired with a pipeline builder. The registry is an ordered list of Routes; first match wins.                                          | `{ match, build }`                         |
| **Registry**   | Ordered list of Routes. Consulted by the bootstrap on every page load.                                                                              | `Route[]`                                  |
| **Pipeline**   | A fully composed chain: `Tap → Adapter(s) → Normalizer → Relay → Teardown`.                                                                         | —                                          |

Adapter and Normalizer share the same signature (`Tap → Tap`), which is what makes them freely composable in any order and count. Relay caps the chain by collapsing it to just a Teardown.

---

## Event Overview

A tab gets opened, a Tap is attached to that tab. That Tap emits a `context: string` in each Capture — the context is an identifier within the tab, e.g. `"root"` by default, but sometimes a specific area like `"dashboard"`. The `source` of a Capture is `<context>@<tab_id>`, e.g. `root@123` or `dashboard@123`.

Each Tap can be wrapped with Adapters for domain-specific behavior — e.g. on a news site an HTML content Adapter triggers on navigation, scroll, and DOM mutations to emit `html.content` Captures, on `file://` a file Adapter categorizes and reads file contents, on Outlook an Outlook Adapter filters transient routes. These are modular and easily replaceable.

The chain is composed like so:

```typescript
const generic  = relay(normalizer(htmlAdapter(tap())))
const outlook  = relay(normalizer(outlookAdapter(tap())))
const file     = relay(normalizer(fileAdapter(tap())))
```

The Relay sends Captures to the service worker via a persistent port. The Normalizer consumes and aggregates events — e.g. raw keystrokes are consumed and batched into a single `input.keystroke_batch` Capture. The whole chain produces a single Teardown that goes into a tab.

## Event Types — [`src/event/types.ts`](../../src/event/types.ts)

Events are a discriminated union keyed on `type`. Two levels:

- **`BaseCapture<T, P>`** — content-script pipeline (no `tabId`/`windowId`/`source` yet): `{ type, timestamp, context, payload }`
- **`BaseEvent<T, P>`** — full stamped event (service worker adds `tabId`, `windowId`, `source`)
- **`Capture`** — union of `BaseCapture` variants (15 content-script event types)
- **`SessionEvent`** — union of `BaseEvent` variants (31 total event types, including service-worker-only events)

Shared target types: `KeystrokeTarget`, `ClickTarget`, `FormTarget`, `Bounds`, `FormFieldInfo`.

Events by layer:

| Layer         | Event types                                                                                                      | Source                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1. Session    | `window.created`, `window.closed`, `window.resized`, `tab.created`, `tab.closed`, `tab.moved`, `tab.transferred` | Service worker (`chrome.windows.*`, `chrome.tabs.*`)                               |
| 2. Navigation | `nav.completed`, `nav.spa`, `nav.title_changed`                                                                  | Service worker (`chrome.webNavigation.*`)                                          |
| 3. Attention  | `attention.visible`                                                                                              | Content script (`visibilitychange`, `focus`, `blur`) via `page:visibility` message |
| 4. Keystrokes | `input.keystroke` (raw), `input.keystroke_batch` (normalized), `input.composition` (raw, consumed by normalizer) | Content script (`keydown`, `composition*`)                                         |
| 5. Mouse      | `input.click`, `input.double_click`, `input.context_menu`                                                        | Content script (`click`, `auxclick`, `dblclick`, `contextmenu`)                    |
| 6. Scroll     | `input.scroll`                                                                                                   | Content script (`scroll`)                                                          |
| 7. Clipboard  | `input.selection`, `input.copy`, `input.paste`                                                                   | Content script (`selectionchange`, `copy`, `paste`)                                |
| 8. Forms      | `input.form_focus`, `input.form_change`, `input.form_submit`                                                     | Content script (`focusin`, `change`, `submit`)                                     |
| 9. Media      | `media.audio`, `media.download`                                                                                  | Service worker (`chrome.tabs.onUpdated`, `chrome.downloads.*`)                     |
| 10. Adapters  | `html.content`                                                                                                   | HTML Adapter (navigation, scroll, mutation triggers)                               |
|               | `file.content`                                                                                                   | File Adapter (file:// pages, categorized by extension)                             |

### Event routing

Events reach the service worker through two paths:

**Via the Relay** (content script pipeline: Tap → Adapter → Normalizer → Relay → service worker port):

| Layer         | Events                                                       |
| ------------- | ------------------------------------------------------------ |
| 4. Keystrokes | `input.keystroke_batch`, `input.keystroke` (meaningful only) |
| 5. Mouse      | `input.click`, `input.double_click`, `input.context_menu`    |
| 6. Scroll     | `input.scroll`                                               |
| 7. Clipboard  | `input.selection`, `input.copy`, `input.paste`               |
| 8. Forms      | `input.form_focus`, `input.form_change`, `input.form_submit` |
| Adapters      | `html.content`, `file.content`                               |

The Normalizer consumes raw `input.keystroke` and `input.composition` events. Printable keystrokes (single-character keys without Ctrl/Alt/Meta) are batched into `input.keystroke_batch` (emitted after 1 s idle). **Meaningful** non-printable keystrokes — action keys (Enter, Backspace, Delete, Tab, Escape, arrow keys, Home, End, PageUp, PageDown) and modifier combos (Ctrl+X, Alt+F, etc.) — flush the buffer and pass through as raw `input.keystroke` events. Lone modifier presses, repeat keys, and all `input.composition` events are consumed without replacement.

**Direct in service worker** (Chrome API listeners in `background/main.ts`, no pipeline):

| Layer         | Events                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1. Session    | `window.created`, `window.closed`, `window.resized`, `tab.created`, `tab.closed`, `tab.moved`, `tab.transferred` |
| 2. Navigation | `nav.completed`, `nav.spa`, `nav.title_changed`                                                                  |
| 3. Attention  | `attention.visible`                                                                                              |
| 9. Media      | `media.audio`, `media.download`                                                                                  |

Most of these come from Chrome extension APIs that are only available in the service worker context. `attention.visible` is the exception — it originates from content scripts via `visibility.ts`, which sends `{ type: "page:visibility", visible, url, title }` to the service worker using `chrome.runtime.sendMessage`. The service worker handler calls `aggregator.setActiveTab(tabId, url)` or `aggregator.setActiveTab(null)` (drives navigation transitions), and also `aggregator.ingestSignal(...)` (records as bundle content). See [navigation.md](../navigation.md) for the full visibility data flow.

```typescript
// ── Pipeline stages ─────────────────────────────────────────

type Teardown = () => void;
type Tap = (sink: (capture: Capture) => void) => Teardown;
type Adapter = (inner: Tap) => Tap;
type Normalizer = (inner: Tap) => Tap;
type Relay = (inner: Tap) => Teardown;
```

## Example: Generic HTML Pipeline — [`src/event/tap.ts`](../../src/event/tap.ts) + [`src/event/adapters/html.ts`](../../src/event/adapters/html.ts)

A Tap that hooks all DOM listeners via a single AbortController, wrapped with an Adapter that injects event-driven HTML content snapshots (deduped by content hash):

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
        timestamp: Date.now(),
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

/** Adapter: wraps any Tap and injects event-driven HTML content snapshots (deduped). */
const htmlAdapter: Adapter = (inner) => {
  return (sink) => {
    let lastHash: string | null = null;
    const teardownInner = inner(sink);

    function takeSnapshot(trigger: HTMLContentPayload["trigger"]) {
      const html = document.documentElement.outerHTML;
      const text = extractDOM();
      const hash = simpleHash(html);
      if (hash === lastHash) return;
      lastHash = hash;
      sink({
        type: "html.content",
        timestamp: Date.now(),
        context: "root",
        payload: {
          trigger,
          url: window.location.href,
          title: document.title,
          viewport: { width: innerWidth, height: innerHeight, scrollY, scrollPercent },
          html,
          text,
        } satisfies HTMLContentPayload,
      });
    }

    // triggers: navigation (on load), scroll (≥ 50% viewport), DOM mutations (dialogs, large content)
    scheduleSnapshot("navigation");
    document.addEventListener("scroll", () => { /* debounced, threshold-gated */ }, { passive: true, signal });
    new MutationObserver(() => { /* settle + debounce → scheduleSnapshot("mutation") */ }).observe(document.body, ...);

    return () => {
      ac.abort();
      observer.disconnect();
      teardownInner();
    };
  };
};
```

Usage — the full generic web pipeline (composed in [`src/event/registry.ts`](../../src/event/registry.ts)):

```typescript
const teardown = relay(normalizer(htmlAdapter(tap())));
```

The Adapter calls `inner(sink)` to pass the sink through, then adds its own Captures on the same sink. This is the core pattern: every Adapter/Normalizer receives a sink, forwards it inward, and optionally injects or transforms on the way out.

## Example: Filtering (Outlook Adapter) — [`src/event/adapters/outlook.ts`](../../src/event/adapters/outlook.ts)

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

## Pipeline Memory

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

## Injection & Lifecycle — [`src/content/main.ts`](../../src/content/main.ts)

A single content script is injected on `<all_urls>` via the manifest. It acts as a thin bootstrap: read the URL, match it against the Registry, assemble the right Pipeline, start it.

**On normal navigation** (user clicks a link, types a URL, etc.), Chrome destroys the entire content script context — all JS state, DOM listeners, timers, everything. Then it re-injects the content script on the new page. The bootstrap runs again, matches the new URL, and builds a fresh Pipeline. There is no manual teardown or replacement — Chrome handles the lifecycle.

**On SPA navigation** (Outlook, Gmail, etc. use History API pushState/replaceState without a real page load), Chrome does *not* re-inject. The content script context survives. For these, the bootstrap installs a URL observer that detects route changes. The pipeline is only torn down and rebuilt if the new URL matches a *different* Route. Navigating within the same SPA (e.g. Outlook inbox → email → calendar) keeps the same pipeline and its closure state alive.

Registry → [`src/event/registry.ts`](../../src/event/registry.ts), Bootstrap → [`src/content/main.ts`](../../src/content/main.ts), SPA Observer → [`src/event/spa-observer.ts`](../../src/event/spa-observer.ts)

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
