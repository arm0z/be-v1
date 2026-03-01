# Translate

Translation is the step that converts a sealed `Bundle` of structured `StampedCapture` objects into a single LLM-readable text block. It exists so that downstream consumers (the packer, sync, and eventually the LLM itself) never need to parse raw event payloads — they get a timestamped, human-readable transcript of what the user did during one focus session on a single source.

## Where it sits

```text
Content Script                     Service Worker
─────────────                     ──────────────
Tap → Adapter → Normalizer → Relay ──port──▶ Aggregator
                                              │
                                              ▼
                                         ┌──────────┐
                                         │ Bundler  │
                                         │          │
                                         │  ingest  │ ← StampedCaptures accumulate
                                         │  seal()  │ ← tab switch / blur
                                         │          │
                                         │  ┌─────────────┐
                                         │  │ translate() │ ← called at seal time
                                         │  └─────────────┘
                                         │         │
                                         │  Bundle.text = "..."
                                         └─────────┘
                                              │
                                              ▼
                                         sealed[] → Packer → Sync (future)
```

Translation happens **at seal time** — when the bundler closes a bundle (tab switch, window blur, or source change), it calls `translate(bundle)` and writes the result into `bundle.text`. This is a one-shot operation: `text` is `null` while the bundle is open, and filled exactly once on seal.

## How it works

`translate()` is a pure function: `Bundle → string`. No state, no side effects, no async.

### Algorithm

1. If the bundle has zero entries, return `""` (empty bundles are valid — rapid tab switches can produce them).
2. For each `BundleEntry` (a `StampedCapture` or `StampedSignal`) in the bundle, call `translateEntry(entry)` which switches on `entry.type` and returns a human-readable action string, or `null` for unhandled types.
3. Non-null results are prefixed with `[HH:MM:SS]` (local time from `entry.timestamp`) and joined with newlines.

### Truncation

A `truncate(str, length, opts?)` helper keeps long strings manageable:

- **End truncation** (default): `truncate("long string", 40)` → `"long stri…"`
- **Center truncation** (`{ fromCenter: true }`): `truncate("long string", 500, { fromCenter: true })` → `"long[…]ring"` — preserves the start and end of the string, cuts the middle.

Truncation is applied to URLs/hrefs (40 chars, end), selected text (500 chars, center), and form field values (500 chars center for long values, 50 chars end for short values like `form_change`). Page and file text content is **not** truncated — the full text body is preserved for LLM consumption.

### Form field formatting

When `input.form_focus` includes a form snapshot, each field is rendered as `name: "value"` on its own line. If the form has more than 10 fields, only the first 5 and last 5 are shown, with a `...: ... (N fields truncated)` line in between.

Field value display follows a priority chain: redacted → checked/unchecked → selectedText → value → (empty).

### Translation table

Each capture type maps to a specific text format:

| Capture type            | Output format                                                                     | Truncation                     |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| `input.keystroke_batch` | `typed "text"`                                                                    | none                           |
| `input.click`           | `clicked "text" (truncated-href…)` or `clicked "text"`                            | href: 40 chars end             |
| `input.double_click`    | `double-clicked "text"`                                                           | none                           |
| `input.context_menu`    | `right-clicked "text"`                                                            | none                           |
| `input.scroll`          | `scrolled to N%`                                                                  | none                           |
| `input.selection`       | `selected "start[…]end"`                                                          | text: 500 chars center         |
| `input.copy`            | `copied (N chars)`                                                                | none (payload has length only) |
| `input.paste`           | `pasted (N chars) into tag`                                                       | none (payload has length only) |
| `input.form_focus`      | `focused name\n  field1: "val"\n  field2: "val"` (field list if snapshot present) | field values: 500 chars center |
| `input.form_change`     | `changed tag to "truncated-val…"` or `changed tag to [redacted]`                  | value: 50 chars end            |
| `input.form_submit`     | `submitted form (N fields) → truncated-action…`                                   | action URL: 40 chars end       |
| `html.content`          | `page: "title" - full text body`                                                  | none (full text preserved)     |
| `file.content`          | `file: truncated-url… - full text body`                                           | url: 40 chars end, text: none  |

#### Signal types (service-worker-originated)

| Signal type         | Output format                                 | Truncation        |
| ------------------- | --------------------------------------------- | ----------------- |
| `nav.completed`     | `navigated to "title" (truncated-url…)`       | url: 40 chars end |
| `nav.spa`           | `navigated to "title" (truncated-url…)`       | url: 40 chars end |
| `nav.title_changed` | `page title → "title"`                        | none              |
| `tab.created`       | `opened new tab: "title" (truncated-url…)`    | url: 40 chars end |
| `tab.closed`        | `closed tab`                                  | none              |
| `attention.active`  | `switched to tab: "title" (truncated-url…)`   | url: 40 chars end |
| `attention.visible` | `browser gained focus` / `browser lost focus` | none              |
| `media.audio`       | `audio started playing` / `audio stopped`     | none              |
| `media.download`    | `downloaded "filename" (state)`               | none              |

Types not in these tables (`input.keystroke`, `input.composition`) return `null` and are silently skipped. These raw types are normally consumed by the normalizer before reaching the service worker, but the translator handles the edge case gracefully.

### Example output

```log
[14:32:01] page: "GitHub - hourglass" - hourglass A browser extension that captures user interactions…
[14:32:05] clicked "Issues" (/hourglass/issues)
[14:32:08] scrolled to 45%
[14:32:10] focused "Title"
  Title: (empty)
  Description: (empty)
  Labels: "bug"
[14:32:12] typed "bug in aggregation"
[14:32:14] clicked "Submit new issue"
[14:32:14] submitted form (3 fields) → /hourglass/issues/new
```

### Design choices

- **Local time, not UTC.** The `[HH:MM:SS]` prefix uses the service worker's local clock via `new Date(timestamp)`. This matches what the user sees on their system clock and makes transcripts immediately readable.
- **Full page/file text.** `html.content` and `file.content` text bodies are preserved in full — no truncation. The LLM needs complete page context to understand user actions.
- **Selective truncation.** URLs/hrefs are truncated to 40 chars (end). Selected text is truncated to 500 chars (center, preserving start and end). Form values use 500 chars center for long values. Form change values use 50 chars end.
- **Form field rendering.** When a form snapshot is available on `input.form_focus`, each field is rendered on its own line with its current value. Forms with more than 10 fields show the first 5 and last 5 with a truncation marker.
- **Redaction passthrough.** `input.form_change` and form field rendering respect the `redacted` flag set by the tap layer (for passwords, credit cards, etc.) and output `[redacted]` instead of the value.
- **Null-safe target text.** Click targets use `text ?? ""` because some elements (e.g. icon buttons, images) have no text content.
- **Form focus fallback chain.** Uses `label → name → placeholder → tag` to find the most descriptive label for a form field.

## Call site

Translation is called in exactly one place:

**[`src/aggregation/bundler.ts:26`](../src/aggregation/bundler.ts)** — inside `seal()`:

```typescript
openBundle.text = translate(openBundle);
```

The bundler imports `translate` and calls it when sealing a bundle. The result is stored on `bundle.text` and included in the `bundle.sealed` dev log payload.

## File map

| File                                                              | Role                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`src/aggregation/translate.ts`](../src/aggregation/translate.ts) | `translate(bundle)` and `translateCapture(capture)` — pure functions, imports `FormFieldInfo` for field rendering |
| [`src/aggregation/types.ts`](../src/aggregation/types.ts)         | `Bundle`, `BundleEntry`, `StampedCapture`, `StampedSignal` type definitions consumed by translate                 |
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts)     | Only call site — `seal()` calls `translate(openBundle)`                                                           |
| [`src/event/types.ts`](../src/event/types.ts)                     | `Capture` discriminated union and all payload interfaces that translate switches on                               |

## Relationship to the aggregation layer

```text
types.ts          ← StampedCapture, StampedSignal, BundleEntry, Bundle, Edge, UNKNOWN, Aggregator interface
translate.ts      ← Bundle → string (this doc)
graph.ts          ← closure-based edge tracking (source → source transitions)
bundler.ts        ← state machine: ingest / ingestSignal / seal / transition (calls translate on seal)
index.ts          ← createAggregator() composes bundler + graph, stamps captures + signals, routes attention events
```

The aggregator is wired into the service worker at [`src/background/main.ts`](../src/background/main.ts):

- Capture port handler calls `aggregator.ingest(capture, tabId)`
- Chrome API listeners call `aggregator.ingestSignal(signal, tabId)` for 9 signal types (nav, tab, attention, media)
- `chrome.tabs.onActivated` calls `aggregator.onTabActivated()` (seals current bundle)
- `chrome.windows.onFocusChanged` calls `aggregator.onWindowFocusChanged(windowId)` (transitions to `"unknown"` on blur, seals on refocus)

Dev panel events for the aggregation layer are registered in [`src/dev/panels/FilterToggles.tsx`](../src/dev/panels/FilterToggles.tsx) under the `AGGREGATOR` and `GRAPH` groups.
