# HTML Adapter

The catch-all pipeline for generic web pages. Applies to any URL that doesn't match a more specific Route (Outlook, file://, etc.).

## Pipeline

```bash
tap() → htmlAdapter() → normalizer() → relay()
```

## What it does

The HTML adapter captures page content using smart, event-driven triggers rather than dumb polling. Each snapshot produces two representations of the page:

- **`html`** — raw `document.documentElement.outerHTML`, capped to a 65 KB byte budget
- **`text`** — cleaned markdown extracted by the DOM extractor (`extract/dom.ts`), with boilerplate stripped and content pruned to the current viewport

## Trigger system

All three triggers funnel through the same `scheduleSnapshot(trigger)` debounce. No trigger can bypass the debounce or cooldown.

### 1. Navigation (`"navigation"`)

Fires immediately when the adapter starts (content script injection at `document_idle`). The 500 ms debounce gives the page time to finish rendering before the first snapshot.

### 2. Scroll (`"scroll"`)

Listens to `scroll` events (passive, cleaned up via `AbortSignal`). Uses a two-stage gate:

1. **Scroll-end detection** — 150 ms idle timer (matches the normalizer's `SCROLL_IDLE_MS`)
2. **Distance threshold** — accumulated scroll delta must reach 50% of viewport height before a snapshot is scheduled

The accumulator resets when a snapshot is scheduled, preventing rapid-fire captures on long smooth scrolls.

### 3. Mutation (`"mutation"`)

A `MutationObserver` on `document.body` with `{ childList: true, subtree: true }`. Only **significant** added nodes trigger a snapshot. A node is significant if any of these are true:

| Check | Condition |
|-------|-----------|
| ARIA dialog | `role="dialog"`, `role="alertdialog"`, or `role="alert"` |
| Modal | `aria-modal="true"` |
| Fixed overlay | `position: fixed` with `innerText` > 20 chars |
| Viewport content | Bounding rect intersects viewport and `innerText` >= 50 chars |

Only the added node itself is checked (not its descendants) — `innerText` already includes child text.

An extra 300 ms settle timer runs before entering the debounce, preventing premature snapshots during CSS animations or multi-step DOM insertions.

## Debounce and cooldown

```
trigger event
    │
    ▼
scheduleSnapshot(trigger)      ← 500 ms debounce (resets on rapid calls)
    │
    ▼
takeSnapshot(trigger)
    ├─ cooldown check           ← skip if < 2 s since last snapshot
    ├─ extract html + text
    ├─ hash dedup               ← skip if html hash unchanged
    └─ emit capture to sink
```

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEBOUNCE_MS` | 500 | Schedule-to-snapshot delay |
| `COOLDOWN_MS` | 2,000 | Minimum time between emitted snapshots |
| `SETTLE_MS` | 300 | Mutation settle before entering debounce |
| `SCROLL_THRESHOLD` | 0.5 | 50% viewport height scroll distance gate |
| `SCROLL_IDLE_MS` | 150 | Scroll-end detection window |
| `CONTENT_BUDGET` | 65,536 | Byte cap for raw `outerHTML` |
| `MUTATION_TEXT_MIN` | 50 | Minimum `innerText` length for viewport mutation nodes |

## DOM extractor (`extract/dom.ts`)

Produces the `text` field — a Firecrawl-inspired markdown conversion using Turndown.js with GFM support.

### Extraction pipeline

1. **Overlay extraction** — finds visible `[role="dialog"]`, `[role="alertdialog"]`, `[role="alert"]`, `[aria-modal="true"]` elements. Each is converted to markdown and prefixed with `**OVERLAY:**`.
2. **Clone body** — `document.body.cloneNode(true)` to avoid mutating the live DOM.
3. **Viewport pruning** — parallel `TreeWalker` over the live DOM and clone in lockstep. Elements whose bounding rects intersect the viewport (plus their ancestors) are kept; everything else is removed deepest-first.
4. **Boilerplate stripping** — removes `nav`, `footer`, `header`, `aside`, ARIA navigation/banner/search roles, common ad/cookie/social class patterns, and noise elements (`script`, `style`, `noscript`, `template`, etc.). Also removes `[hidden]`, `[aria-hidden="true"]`, inline `display:none` / `visibility:hidden`, and already-captured overlays.
5. **Turndown conversion** — converts the cleaned clone to markdown.
6. **Post-processing** — collapses runs of 3+ newlines to double newlines.

### Turndown rules

| Rule | Behavior |
|------|----------|
| `strip-img` | Replaces `<img>` with `<src>` (token savings) |
| `truncate-urls` | Truncates link `href` to 40 chars |
| `strip-embed` | Removes `<svg>`, `<canvas>`, `<iframe>` |
| `form-inputs` | Renders `<input>`, `<select>`, `<textarea>` as bracket annotations with type/placeholder/value (sensitive fields redacted via shared `isSensitiveField`) |

## Emitted event

```ts
{
    type: "html.content",
    timestamp: number,
    context: "root",
    payload: {
        trigger: "navigation" | "scroll" | "mutation",
        url: string,          // window.location.href
        title: string,        // document.title
        viewport: {
            width: number,
            height: number,
            scrollY: number,
            scrollPercent: number,
        },
        html: string,         // raw outerHTML (up to 65 KB)
        text: string,         // cleaned markdown from DOM extractor
    }
}
```

## Teardown

- `AbortController.abort()` removes the scroll listener
- `MutationObserver.disconnect()` stops DOM observation
- All timer refs (`debounceTimer`, `settleTimer`, `scrollIdleTimer`) are cleared
- Inner tap's teardown is called

## File map

| File | Role |
|------|------|
| `src/event/adapters/html.ts` | Adapter — triggers, debounce, cooldown, hash dedup |
| `src/event/extract/dom.ts` | DOM extractor — clone, prune, strip, Turndown conversion |
| `src/event/dom-utils.ts` | Shared `isSensitiveField` (used by both `tap.ts` and the extractor) |
| `src/event/types.ts` | `HTMLContentPayload` type definition |

## Dev panel verification

Filter on the `adapter` channel in the dev panel:

1. Load a page — see `trigger: "navigation"` within ~500 ms
2. Scroll > 50% viewport, stop — see `trigger: "scroll"`
3. Visit a page with dialogs/modals — see `trigger: "mutation"`
4. Rapid triggers — see "snapshot skipped (cooldown)" in dev logs
5. No-change trigger — see "snapshot skipped (same hash)" in dev logs
