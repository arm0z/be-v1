# Translate

Translation is the step that converts a sealed `Bundle` of structured `StampedCapture` objects into a single LLM-readable text block. It exists so that downstream consumers (the packer, sync, and eventually the LLM itself) never need to parse raw event payloads — they get a compact, human-readable transcript of what the user did during one focus session on a single source.

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
                                         sealed[] → Packer → Sync
```

Translation happens **at seal time** — when the bundler closes a bundle (tab switch, window blur, or source change), it calls `translate(bundle)` and writes the result into `bundle.text`. This is a one-shot operation: `text` is `null` while the bundle is open, and filled exactly once on seal.

## How it works

`translate()` is a pure function: `Bundle → string`. No state, no side effects, no async.

### Algorithm

1. If the bundle has zero entries, return `""` (empty bundles are valid — rapid tab switches can produce them).
2. For each `BundleEntry` (a `StampedCapture` or `StampedSignal`) in the bundle, call `translateEntry(c)` which switches on `c.type` and returns a human-readable action string, or `null` for unhandled types.
3. Consecutive entries of the same `type` are collapsed — only the last entry in a run is kept. This eliminates noise from repeated scrolls, rapid navigations to the same URL, etc.
4. A `[HH:MM]` timestamp header is emitted only when the minute changes (or for the first entry). Entries within the same minute have no timestamp prefix. Seconds are omitted entirely — minute-level granularity is sufficient for the LLM to understand sequencing.

### Truncation

A `truncate(str, length, opts?)` helper keeps long strings manageable:

- **End truncation** (default): `truncate("long string", 40)` → `"long stri…"`
- **Center truncation** (`{ fromCenter: true }`): `truncate("long string", 500, { fromCenter: true })` → `"long[…]ring"` — preserves the start and end of the string, cuts the middle.

Truncation is applied to URLs/hrefs (40 chars, end), selected text (500 chars, center), and form field values. Within form field rendering (`formatField`), `selectedText` uses 50 chars end truncation and `value` uses 500 chars center truncation. `form_change` values use 50 chars end. Page and file text content is **not** truncated — the full text body is preserved for LLM consumption.

### Form field formatting

When `input.form_focus` includes a form snapshot, each field is rendered as `name: "value"` on its own line. Empty fields (no value, not checked, not redacted) are omitted entirely — the LLM gains nothing from seeing them. If the remaining non-empty fields exceed 10, only the first 5 and last 5 are shown, with a `...: ... (N fields truncated)` line in between.

Field value display follows a priority chain: redacted → checked/unchecked → selectedText → value. If none apply, the field is skipped.

### Collapsing consecutive events

Before rendering, consecutive entries of certain **collapsible** types are collapsed to keep only the last entry in each run. Only types where the last value fully supersedes all previous values are collapsible — positional state (`input.scroll`, `input.selection`), boolean state (`attention.visible`, `media.audio`), and content snapshots (`outlook.content`). Action types like clicks, keystrokes, and form changes are never collapsed — two consecutive clicks (e.g. "Edit" then "Save") are distinct actions that must both appear.

For example, five consecutive `input.scroll` entries produce a single `scroll N%` line showing the final position, and periodic `outlook.content` snapshots during a long compose session collapse to just the final snapshot.

### Translation table

Each capture type maps to a specific text format:

| Capture type            | Output format                                                                   | Truncation                              |
| ----------------------- | ------------------------------------------------------------------------------- | --------------------------------------- |
| `input.keystroke_batch` | `type "text"`                                                                   | none                                    |
| `input.keystroke`       | `key Ctrl+Alt+Shift+Meta+key` (modifier prefixes + key)                         | none                                    |
| `input.click`           | `click "text" truncated-href…` or `click "text"`                                | href: 40 chars end                      |
| `input.double_click`    | `dblclick "text"`                                                               | none                                    |
| `input.context_menu`    | `rclick "text"`                                                                 | none                                    |
| `input.scroll`          | `scroll N%`                                                                     | none                                    |
| `input.selection`       | `select "start[…]end"`                                                          | text: 500 chars center                  |
| `input.copy`            | `copy N`                                                                        | none (payload has length only)          |
| `input.paste`           | `paste N->tag`                                                                  | none (payload has length only)          |
| `input.form_focus`      | `focus name\n  field1: "val"\n  field2: "val"` (field list if snapshot present) | selectedText: 50 end, value: 500 center |
| `input.form_change`     | `set tag "truncated-val…"` or `set tag [redacted]`                              | value: 50 chars end                     |
| `input.form_submit`     | `submit Nf->truncated-action…`                                                  | action URL: 40 chars end                |
| `html.content`          | `page "title" full text body`                                                   | none (full text preserved)              |
| `file.content`          | `file truncated-url… full text body`                                            | url: 40 chars end, text: none           |

#### Outlook adapter types

| Capture type       | Output format                                                                                             | Truncation                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `outlook.navigate` | `nav folder messageId?`                                                                                   | messageId: 20 chars end                                                |
| `outlook.send`     | `send email`                                                                                              | none                                                                   |
| `outlook.discard`  | `discard draft`                                                                                           | none                                                                   |
| `outlook.content`  | `email (mode) "subject"\n  from: …\n  to: …\n  cc: …\n  N attachments: …\n  body` (empty fields omitted) | subject: 40 end, body: 1000 center, recipients/attachments: 3 shown +N |

#### Signal types (service-worker-originated)

| Signal type         | Output format                   | Truncation        |
| ------------------- | ------------------------------- | ----------------- |
| `nav.completed`     | `nav "title" truncated-url…`    | url: 40 chars end |
| `nav.spa`           | `nav "title" truncated-url…`    | url: 40 chars end |
| `nav.title_changed` | `title->"title"`                | none              |
| `tab.created`       | `newtab "title" truncated-url…` | url: 40 chars end |
| `tab.closed`        | `closetab`                      | none              |
| `attention.visible` | `focus` / `blur`                | none              |
| `media.audio`       | `audio on` / `audio off`        | none              |
| `media.download`    | `dl "filename" state`           | none              |

Types not in these tables (`input.composition`) return `null` and are silently skipped. `input.keystroke` has an explicit handler (see table above) since non-printable/modified keystrokes pass through the normalizer without being batched. `input.composition` is consumed by the normalizer and should not reach the bundler, but returns `null` gracefully if it does.

### Example output

```log
[14:32]
page "GitHub - hourglass" hourglass A browser extension that captures user interactions…
click "Issues" /hourglass/issues
scroll 45%
focus "Title"
  Labels: "bug"
type "bug in aggregation"
click "Submit new issue"
submit 3f->/hourglass/issues/new
[14:33]
nav "Issue #42" /hourglass/issues/42
scroll 80%
```

Note how empty form fields (Title, Description) are omitted, and the `[14:33]` header only appears when the minute rolls over. All lines between `[14:32]` and `[14:33]` happened in the same minute.

### Design choices

- **Minute-level timestamps.** A `[HH:MM]` header is emitted only when the minute changes. Lines within the same minute carry no prefix. This saves ~5 tokens per line compared to per-line `[HH:MM:SS]` timestamps while still giving the LLM enough temporal context to understand sequencing. Seconds are unnecessary — the LLM cares about *what happened*, not sub-minute timing.
- **Collapse consecutive duplicates.** Runs of the same collapsible type are reduced to the last entry. Five scroll events become one final scroll position; periodic email snapshots collapse to the latest draft. Only positional/state/snapshot types collapse — action types (clicks, keystrokes, form changes) never collapse.
- **Omit empty form fields.** Fields with no value, no selection, and no checked state are skipped entirely. A mostly-empty 20-field form renders as 2–3 lines instead of 20. Only fields with actual content are useful to the LLM.
- **Full page/file text.** `html.content` and `file.content` text bodies are preserved in full — no truncation. The LLM needs complete page context to understand user actions.
- **Truncated email snapshots.** `outlook.content` is heavily truncated: subject to 40 chars, body to 1000 chars (center), recipients and attachments show the first 3 items with `[+N]` for overflow. Unlike generic page content, email snapshots fire repeatedly (periodic T5 snapshots) and the structured fields convey enough signal without full-length values.
- **Selective truncation.** URLs/hrefs are truncated to 40 chars (end). Selected text is truncated to 500 chars (center, preserving start and end). Form values use 500 chars center for long values. Form change values use 50 chars end.
- **Redaction passthrough.** `input.form_change` and form field rendering respect the `redacted` flag set by the tap layer (for passwords, credit cards, etc.) and output `[redacted]` instead of the value.
- **Null-safe target text.** Click targets use `text ?? ""` because some elements (e.g. icon buttons, images) have no text content.
- **Form focus fallback chain.** Two separate chains: the entry-level label in `translateEntry` uses `name → placeholder → tag` (from the focused element's target). The per-field labels in `formatField` use `label → name → placeholder → tag` (from `FormFieldInfo`, where `label` is the `<label>` text).

## Call sites

Translation is called in two places within [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts):

1. **Line 35** — inside `seal()`:

   ```typescript
   openBundle.text = translate(openBundle);
   ```

2. **Line 176** — inside `restore()`, when sealing a stale open bundle from a checkpoint:

   ```typescript
   stale.text = translate(stale);
   ```

## File map

| File                                                              | Role                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`src/aggregation/translate.ts`](../src/aggregation/translate.ts) | `translate(bundle)` and `translateEntry(c)` — pure functions, imports `FormFieldInfo` for field rendering |
| [`src/aggregation/types.ts`](../src/aggregation/types.ts)         | `Bundle`, `BundleEntry`, `StampedCapture`, `StampedSignal` type definitions consumed by translate         |
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts)     | Call sites — `seal()` calls `translate(openBundle)`, `restore()` calls `translate(stale)`                 |
| [`src/event/types.ts`](../src/event/types.ts)                     | `Capture` discriminated union and all payload interfaces that translate switches on                       |

## Relationship to the aggregation layer

```text
types.ts          ← StampedCapture, StampedSignal, BundleEntry, Bundle, Transition, UNKNOWN, Aggregator, Checkpoint
translate.ts      ← Bundle → string (this doc)
bundler.ts        ← state machine: ingest / ingestSignal / seal / transition (calls translate on seal and restore)
index.ts          ← createAggregator() composes bundler, stamps captures + signals, routes visibility events, tracks sourceUrls
```

The aggregator is wired into the service worker at [`src/background/main.ts`](../src/background/main.ts):

- Capture port handler calls `aggregator.ingest(capture, tabId)`
- Chrome API listeners call `aggregator.ingestSignal(signal, tabId)` for signal types (nav, tab, media)
- The dual-layer active tab tracking (content script `page:visibility` + Chrome `tabs.onActivated` / `windows.onFocusChanged`) calls `aggregator.setActiveTab(tabId | null, url?)` — drives navigation transitions

Dev panel events for the aggregation layer are registered in [`src/dev/panels/FilterToggles.tsx`](../src/dev/panels/FilterToggles.tsx) under the `AGGREGATOR` group.
