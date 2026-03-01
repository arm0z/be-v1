# Outlook Adapter

Domain-specific adapter for Outlook Web (`outlook.office.com`, `outlook.live.com`). Registers each email as its own source by deriving a **dynamic context** from the URL and DOM state, enabling per-email time tracking and event attribution.

## Pipeline

```bash
tap() → outlookAdapter() → normalizer() → relay()
```

## Implementation status

| Feature                            | Status   | Notes                                                                                |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| DOM-based context rewriting        | **Done** | `resolveDomContext()` hashes subject+from; 300ms settle; URL fallback                |
| `outlook.navigate` event           | **Done** | Emitted on URL change via poll + popstate + reactive check                           |
| Internal SPA navigation tracking   | **Done** | 300ms poll + popstate + reactive on each capture                                     |
| Unsupported path fallback          | **Done** | Unsupported paths (deleted/junk/archive/search/bare) fall back to `other` context    |
| Registry consolidation             | **Done** | Single route matching `outlook.office.com/mail/` and `outlook.(com\|live.com)/mail/` |
| DOM-layer compose detection        | **Done** | `MutationObserver` for compose pane appearance/disappearance                         |
| Reply/forward mode detection       | **Done** | Subject prefix parsing (`Re:` / `Fw:`)                                               |
| `outlook.content` snapshot         | **Done** | Structured email extraction (to/cc/bcc/subject/body)                                 |
| `outlook.send` / `outlook.discard` | **Done** | Send/Discard button click detection + inferred send fallback                         |

## Supported contexts

The adapter produces six primary context types. All other Outlook paths fall back to `other` — captures still flow (time is tracked, transitions are visible) but no content snapshots or outlook-specific events are emitted.

| Context                    | Source                                                              | Layer                 |
| -------------------------- | ------------------------------------------------------------------- | --------------------- |
| `inbox` / `inbox:<hash>`   | List: URL. Read: DOM `subject+from` hash (URL fallback)             | Layer 1 (implemented) |
| `sent` / `sent:<hash>`     | List: URL. Read: DOM `subject+from` hash (URL fallback)             | Layer 1 (implemented) |
| `drafts` / `drafts:<hash>` | List: URL. Read: DOM `subject+from` hash (URL fallback)             | Layer 1 (implemented) |
| `compose:<draft_hash>`     | DOM — compose pane open, subject has no `Re:`/`Fw:` prefix | Layer 2 (implemented) |
| `reply:<draft_hash>`       | DOM — compose pane open, subject starts with `Re:`         | Layer 2 (implemented) |
| `forward:<draft_hash>`     | DOM — compose pane open, subject starts with `Fw:`         | Layer 2 (implemented) |

Full-page compose via URL (`/mail/compose/{id}` or `/mail/deeplink/compose`) is also supported in Layer 1 and produces `compose` / `compose:<hash>`.

### Unsupported paths → `other`

These URL segments are not in `FOLDER_MAP` and fall back to `context: "other"`. Captures still flow through (time is tracked, source transitions happen), but no content snapshots or outlook-specific events are emitted for these pages:

- `/mail/` (bare landing)
- `/mail/deleteditems/` — deleted items
- `/mail/junkemail/` — junk/spam
- `/mail/archive/` — archive
- `/mail/search/` — search results
- Any other unrecognized `/mail/{segment}/` path

This ensures the bundler always sees transitions (e.g. `inbox:k7f2m9x` → `other` → `sent:p4n9t3r`) and time accounting is correct, without a black hole. If full support for any of these is needed later, add the segment to `FOLDER_MAP` in `outlook.ts`.

## Core concept: per-email source registration

Unlike the HTML or file adapters which use a static `context: "root"`, the Outlook adapter **rewrites the context on every capture** based on the current URL (and, once implemented, DOM state). The aggregator then combines it with `tabId` to form the source:

```text
User opens email A → URL: /mail/inbox/id/AAkALg...VAAA
  → adapter parses URL → context = "inbox:k7f2m9x1"
  → aggregator stamps  → source  = "inbox:k7f2m9x1@142"

User opens email B → URL: /mail/inbox/id/BBkXMp...QAAA
  → adapter parses URL → context = "inbox:m3p8q2w5"
  → aggregator stamps  → source  = "inbox:m3p8q2w5@142"
  → bundler sees new source → source transition → new bundle

User clicks Reply on email B → compose pane opens (no URL change)
  → adapter detects DOM → context = "reply:a8f3k2"
  → aggregator stamps  → source  = "reply:a8f3k2@142"
  → bundler sees new source → source transition → new bundle
```

Each distinct context creates a distinct source. Navigating between emails or entering/exiting compose triggers a source transition in the bundler automatically.

---

## Layer 1: URL + DOM-based context (implemented)

### DOM-based read-mode hashing

When an email is opened (URL contains a message ID), the adapter hashes `subject + from` from the DOM reading pane via `resolveDomContext()` instead of the URL message ID. This produces **stable** context hashes — Outlook's URL IDs change on every visit to the same email, but subject+from do not.

**Deferred resolution (300ms settle window):** The URL changes immediately via pushState, but the DOM reading pane takes ~100-200ms to render the new email. Reading the DOM right after URL change yields the OLD email's subject. The adapter defers context resolution by 300ms (`NAV_SETTLE_MS`) to let the DOM settle. During the settle window, captures continue flowing with the **previous** context (correct — the click that triggered navigation belongs to the old email). If the DOM is not ready after 300ms, falls back to URL hash (no regression). If another URL change arrives during settle, the old timer is cancelled.

Folder-only navigation (list views without a message ID) resolves immediately with no settle delay.

### Supported URL patterns

| URL pattern               | Folder   | Context example  | Description         |
| ------------------------- | -------- | ---------------- | ------------------- |
| `/mail/inbox/`            | `inbox`  | `inbox`          | Inbox list          |
| `/mail/inbox/id/{id}`     | `inbox`  | `inbox:<hash>`   | Reading inbox email |
| `/mail/sentitems/`        | `sent`   | `sent`           | Sent items list     |
| `/mail/sentitems/id/{id}` | `sent`   | `sent:<hash>`    | Viewing sent email  |
| `/mail/drafts/`           | `drafts` | `drafts`         | Drafts list         |
| `/mail/drafts/id/{id}`    | `drafts` | `drafts:<hash>`  | Editing a draft     |
| `/mail/compose/{id}`      | —        | `compose:<hash>` | Full-page compose   |
| `/mail/deeplink/compose`  | —        | `compose`        | New compose (no ID) |

### Current implementation

All URL parsing, hashing, and context resolution lives in `src/event/adapters/outlook.ts`:

```typescript
// Regex matches /mail/ optionally followed by folder/id segments
const ROUTE_RE = /\/mail\/(?:([a-z]+)\/(?:id\/(.+?)(?:\/|$)|rp\/(.+?)(?:\/|$))?)?$/;

// Compose uses direct IDs: /mail/compose/{id} (no id/ prefix)
const COMPOSE_RE = /\/mail\/compose\/([^/]+)\/?$/;

// Supported URL segments → specific folder; everything else → "other"
const FOLDER_MAP: Record<string, string> = {
    inbox: "inbox", sentitems: "sent", drafts: "drafts",
    compose: "compose", deeplink: "compose",
};

interface OutlookRoute {
    folder: string;
    messageId: string | null;
}

// Falls back to { folder: "other", messageId: null } for unsupported paths
// COMPOSE_RE handles /mail/compose/{id} (drafts opened in full-page compose)
function parseOutlookUrl(pathname: string): OutlookRoute { ... }
function shortHash(id: string): string { ... }       // FNV-1a → base36
function resolveDomContext(folder: string): string | null { ... }  // hash subject+from from DOM
```

`resolveDomContext()` reads `subject` and `from` from the DOM reading pane and returns `folder:hash(subject+from)`, or `null` if the DOM isn't ready. `checkNavigation()` inlines the URL fallback (`folder:hash(messageId)`) for when the DOM is unavailable.

When a URL segment is not in `FOLDER_MAP`, `parseOutlookUrl()` falls back to `folder: "other"`. Captures still flow through with `context: "other"`, ensuring time tracking and source transitions are preserved.

### Hash function

Message IDs are long URL-encoded strings (e.g. `AAkALgAAAAAAHYQDEapmEc2byACqAC%2FEWg0AX0WoIDuRA0umSY1YdRNbygAAS3L4VAAA`). The adapter hashes them to a short, deterministic, collision-resistant string.

**Algorithm**: FNV-1a (32-bit) → base36 → 7 characters

```typescript
function shortHash(id: string): string {
    let h = 0x811c9dc5;               // FNV offset basis
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193); // FNV prime
    }
    return (h >>> 0).toString(36);     // unsigned → base36, max 7 chars
}
```

Properties:

- **Deterministic**: same ID always produces the same hash
- **Short**: 6–7 base36 chars (e.g. `k7f2m9x`)
- **No dependencies**: pure arithmetic, no crypto API needed
- **Collision-safe**: ~4 billion possible values; collisions within a single tab are effectively impossible

### Context format

```text
<folder>            — list view (no specific email)
<folder>:<hash>     — specific email within a folder (hash from DOM subject+from, URL fallback)
```

Full source (after aggregator stamps): `<folder>:<hash>@<tabId>`

In read mode, `<hash>` is derived from `subject + from` via the DOM (stable across visits). Falls back to URL message ID hash if DOM is unavailable.

Examples:

| URL                            | Context           | Hash source            | Source (tab 142)      |
| ------------------------------ | ----------------- | ---------------------- | --------------------- |
| `/mail/inbox/`                 | `inbox`           | —                      | `inbox@142`           |
| `/mail/inbox/id/AAk...VAAA`    | `inbox:k7f2m9x`   | DOM subject+from       | `inbox:k7f2m9x@142`   |
| `/mail/sentitems/id/BBx...QAA` | `sent:p4n9t3r`    | DOM subject+from       | `sent:p4n9t3r@142`    |
| `/mail/drafts/`                | `drafts`          | —                      | `drafts@142`          |
| `/mail/compose/AAk...rAAA`     | `compose:m3p8q2w` | URL message ID         | `compose:m3p8q2w@142` |
| `/mail/deeplink/compose`       | `compose`         | —                      | `compose@142`         |
| `/mail/deleteditems/id/...`    | `other`           | —                      | `other@142`           |

### Internal navigation tracking (implemented)

Since Outlook is an SPA and all its URLs match the same Route, the SPA observer in `content/main.ts` will **not** rebuild the pipeline on internal navigation. The adapter detects URL changes itself via three mechanisms:

1. **Reactive (on capture)** — every time the inner tap emits a capture, the adapter checks `location.pathname`. If it changed, it emits `outlook.navigate` before forwarding the capture with the new context.

2. **Proactive (polling)** — a 300 ms `setInterval` compares `location.pathname` against `lastPath`. Cheap — single string comparison per tick.

3. **Proactive (popstate)** — a `popstate` listener catches back/forward navigation.

```text
inner capture arrives
    │
    ├─ pathname changed?
    │   ├── YES → emit outlook.navigate, update lastPath + currentCtx
    │   └── NO  → continue
    │
    ▼
sink({ ...capture, context: currentCtx })
```

### Context rewriting (implemented)

The adapter wraps the inner Tap and rewrites `context` on every forwarded capture. With Layer 2, `effectiveCtx()` returns `overlayCtx ?? currentCtx` — the DOM-detected compose context takes priority over the URL-based context:

```typescript
const teardownInner = inner((capture) => {
    checkNavigation();
    sink({ ...capture, context: effectiveCtx() });
});
```

No changes to `tap.ts` or the aggregator are needed.

---

## Layer 2: DOM-based compose detection (implemented)

### Problem

Compose, reply, and forward open as **inline panes** without changing the URL. The URL stays at the email being read (e.g. `/mail/inbox/id/AAk...`), so the URL-based context continues to report `inbox:<hash>` while the user is actually composing.

### DOM signals discovered

From DOM snapshot analysis (`outlook/` directory — `read.html`, `reply.html`, `forward.html`, `compose.html`), the following elements are **present only when a compose/reply/forward pane is open** and **absent in read mode**:

| Element        | Selector                                                  | Read mode                                                 | Compose/Reply/Forward                 |
| -------------- | --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| Compose editor | `div[aria-label="Message body"][contenteditable="true"]`  | Absent (read has `role="document"`, no `contenteditable`) | Present                               |
| Send button    | `[data-testid="ComposeSendButton"]`                       | Absent                                                    | Present                               |
| Send action    | `button[aria-label="Send"]`                               | Absent                                                    | Present (`title="Send (Ctrl+Enter)"`) |
| Discard button | `button#discardCompose` or `button[aria-label="Discard"]` | Absent                                                    | Present (`title="Discard (Esc)"`)     |
| Subject input  | `input[aria-label="Subject"]`                             | Absent                                                    | Present                               |
| To field       | `div[aria-label="To"][contenteditable="true"]`            | Absent (read has `aria-readonly="true"`)                  | Present                               |
| Cc field       | `div[aria-label="Cc"][contenteditable="true"]`            | Absent                                                    | Present (may be hidden via CSS)       |

**Primary detection signal**: `div[aria-label="Message body"][contenteditable="true"]` — this is the single most reliable indicator that a compose pane is open.

### Read mode DOM (for comparison)

In read mode, the same semantic fields exist but with different attributes:

| Field          | Selector                                         | Notes                                                                       |
| -------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Subject (read) | `span[id$="_SUBJECT"][role="heading"]`           | ID format: `MSG_{shortId}_SUBJECT`                                          |
| From (read)    | `span[aria-label^="From:"]`                      | `aria-label="From: Ramp"` — parse after colon                               |
| To (read)      | `div[aria-label^="To:"]`                         | `aria-label="To: Test Account"` — parse after colon, `aria-readonly="true"` |
| Body (read)    | `div[id^="UniqueMessageBody_"][role="document"]` | ID format: `UniqueMessageBody_1`                                            |

### Distinguishing compose vs reply vs forward

The subject `input[aria-label="Subject"]` has a `.value` that reveals the mode:

| Subject value              | Mode          | Context                |
| -------------------------- | ------------- | ---------------------- |
| Empty or custom text       | Fresh compose | `compose:<draft_hash>` |
| Starts with `Re:` or `RE:` | Reply         | `reply:<draft_hash>`   |
| Starts with `Fw:` or `FW:` | Forward       | `forward:<draft_hash>` |

```typescript
function detectComposeMode(subjectValue: string): "compose" | "reply" | "forward" {
    const trimmed = subjectValue.trimStart();
    if (/^Re:/i.test(trimmed)) return "reply";
    if (/^Fw:/i.test(trimmed)) return "forward";
    return "compose";
}
```

### Draft ID extraction

The subject input's `id` attribute contains a per-draft identifier:

```text
id="MSG_59b8f0b1aa3_SUBJECT"  →  draft ID = "59b8f0b1aa3"
id="MSG_7b3e9474436_SUBJECT"  →  draft ID = "7b3e9474436"
```

Parse with: `/^MSG_(.+)_SUBJECT$/` → group 1 is the draft ID. Hash it with `shortHash()` to produce the context hash.

This means each compose session gets its own unique source, even though the URL never changes:

```text
Reading email A → context: "inbox:k7f2m9x"     (URL-based, Layer 1)
Click Reply     → context: "reply:a8f3k2"       (DOM-based, Layer 2, draft ID 59b8f0b1aa3)
Type response   → context: "reply:a8f3k2"       (keystrokes attributed here)
Send/Discard    → context: "inbox:k7f2m9x"      (DOM layer clears, back to Layer 1)

Click Reply again → context: "reply:m4p9w1"     (different draft ID 7b3e9474436)
```

### Two-layer context resolution

`resolveContext()` must be updated to check DOM state first, then fall back to URL:

```text
resolveContext():
    1. Is compose pane open? (overlayCtx set by MutationObserver)
       YES → return overlayCtx (e.g. "reply:a8f3k2")
    2. Fall back to URL-based resolution
       return parseOutlookUrl(pathname) → "inbox:k7f2m9x" or "other"
```

The `overlayCtx` is maintained by the `MutationObserver` and takes priority over URL-based context whenever set.

### MutationObserver design

A `MutationObserver` on `document.body` with `{ childList: true, subtree: true }` watches for:

- **Compose pane appearing**: a node added that matches `div[aria-label="Message body"][contenteditable="true"]` or contains `[data-testid="ComposeSendButton"]`.
- **Compose pane disappearing**: the above elements are removed from the DOM.

On detection:

1. Extract the draft ID from `input[aria-label="Subject"]` `.id` → parse `/^MSG_(.+)_SUBJECT$/`
2. Extract the mode from `input[aria-label="Subject"]` `.value` prefix → `detectComposeMode()`
3. Set `overlayCtx` (e.g. `"reply:a8f3k2"`)
4. Emit `outlook.navigate` with the new context

On removal:

1. Clear `overlayCtx` to `null`
2. Emit `outlook.navigate` reverting to URL-based context

The observer should debounce by ~100ms to avoid reacting to intermediate DOM states during pane animation.

---

## `outlook.content` — email snapshot (implemented)

Structured extraction of the email currently being viewed or composed. Analogous to the HTML adapter's `html.content` but produces structured JSON instead of raw HTML.

### Snapshot shape

```typescript
export interface OutlookContentPayload {
    mode: "read" | "compose" | "reply" | "forward";
    subject: string;
    from: string | null;         // null in compose/reply/forward
    to: string[];
    cc: string[];
    bcc: string[];               // only available in compose mode
    body: string;                // innerText, budgeted to 65KB
    attachments: string[];       // filenames only (e.g. ["contract.pdf", "exhibit_a.docx"])
    draftId: string | null;      // from subject input ID, null in read mode
}
```

### Extraction selectors

**Read mode** — extracting the email the user is viewing:

| Field       | Selector                                         | Extraction method                          |
| ----------- | ------------------------------------------------ | ------------------------------------------ |
| Subject     | `span[id$="_SUBJECT"][role="heading"]`           | `.innerText`                               |
| From        | `span[aria-label^="From:"]`                      | parse `aria-label` after `"From: "` prefix |
| To          | `div[aria-label^="To:"]`                         | parse pill spans (see below)               |
| Cc          | `div[aria-label^="Cc:"]`                         | parse pill spans (see below)               |
| Bcc         | —                                                | not visible in read mode                   |
| Body        | `div[id^="UniqueMessageBody_"][role="document"]` | `.innerText` capped to 65KB                |
| Attachments | `div[aria-label="Attachments"] button`           | `.textContent` per button                  |

**Compose/Reply/Forward mode** — extracting the draft being edited:

| Field       | Selector                                                 | Extraction method                                                   |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Subject     | `input[aria-label="Subject"]`                            | `.value`                                                            |
| From        | —                                                        | not directly available in compose DOM                               |
| To          | `div[aria-label="To"][contenteditable="true"]`           | parse pill spans (see below)                                        |
| Cc          | `div[aria-label="Cc"][contenteditable="true"]`           | parse pill spans (see below)                                        |
| Bcc         | `div[aria-label="Bcc"][contenteditable="true"]`          | parse pill spans (see below)                                        |
| Body        | `div[aria-label="Message body"][contenteditable="true"]` | `.innerText` capped to 65KB                                         |
| Draft ID    | `input[aria-label="Subject"]`                            | parse `.id` with `/^MSG_(.+)_SUBJECT$/`                             |
| Attachments | `[data-testid="AttachmentCard"]`                         | `.textContent` per card (fallback: `div[aria-label^="Attachment"]`) |

### Recipient parsing strategy

The `aria-label` approach (e.g. `aria-label="To: Name1, Name2"`) breaks for 5+ recipients — Outlook truncates the label or restructures the DOM. Instead, parse the individual **pill spans** inside each recipient field:

**Read mode** — `span.lpc-hoverTarget` within the To/Cc container:

```typescript
function extractReadRecipients(field: "To" | "Cc"): string[] {
    const container = document.querySelector(`div[aria-label^="${field}:"]`);
    if (!container) return [];

    // Primary: parse individual pill spans (reliable for large recipient lists)
    const pills = container.querySelectorAll("span.lpc-hoverTarget");
    if (pills.length > 0) {
        return Array.from(pills)
            .map(s => s.textContent?.trim())
            .filter((s): s is string => !!s);
    }

    // Fallback: parse aria-label (works for 1-3 recipients)
    const label = container.getAttribute("aria-label") ?? "";
    const after = label.replace(new RegExp(`^${field}:\\s*`), "");
    return after ? after.split(/,\s*/) : [];
}
```

**Compose mode** — `span[data-lpc-hover-target-id]` within contenteditable fields:

```typescript
function extractComposeRecipients(field: "To" | "Cc" | "Bcc"): string[] {
    const container = document.querySelector(
        `div[aria-label="${field}"][contenteditable="true"]`
    );
    if (!container) return [];

    // Primary: parse pill spans (each recipient is a separate span)
    const pills = container.querySelectorAll("span[data-lpc-hover-target-id]");
    if (pills.length > 0) {
        return Array.from(pills)
            .map(p => p.textContent?.trim())
            .filter((s): s is string => !!s);
    }

    // Fallback: split innerText by semicolons/newlines
    return container.innerText
        .split(/[;\n]/)
        .map(s => s.trim())
        .filter(Boolean);
}
```

### Attachment extraction

**Read mode** — buttons inside the attachment well:

```typescript
function extractReadAttachments(): string[] {
    const buttons = document.querySelectorAll('div[aria-label="Attachments"] button');
    return Array.from(buttons)
        .map(el => el.textContent?.trim() ?? "")
        .filter(Boolean);
}
```

**Compose mode** — attachment cards:

```typescript
function extractComposeAttachments(): string[] {
    const cards = document.querySelectorAll('[data-testid="AttachmentCard"]');
    if (cards.length > 0) {
        return Array.from(cards)
            .map(el => el.textContent?.trim() ?? "")
            .filter(Boolean);
    }
    // Fallback: aria-label based
    const labeled = document.querySelectorAll('div[aria-label^="Attachment"]');
    return Array.from(labeled)
        .map(el => {
            const label = el.getAttribute("aria-label") ?? "";
            return label.replace(/^Attachment[:\s]*/i, "").trim();
        })
        .filter(Boolean);
}
```

Notes:

- The Cc field may be hidden with a CSS class (`g7toD` was observed) — check `offsetHeight > 0` or `display !== "none"` before extracting
- Bcc is only present if the user has toggled it on; if the element doesn't exist, emit `[]`
- Attachment filenames may include size suffixes (e.g. "contract.pdf (2.1 MB)") — strip with regex if needed
- The body element's `id` has a numeric suffix (`UniqueMessageBody_1`) — use `^=` prefix match

### Capture type

```typescript
{
    type: "outlook.content",
    timestamp: number,
    context: string,           // current context (inbox:hash, reply:hash, etc.)
    payload: OutlookContentPayload
}
```

### Snapshot triggers

Two triggers, no periodic timers:

1. **After every `emitNavigate()`** → `scheduleSnapshot()` starts a 30-second countdown. If a new navigate fires before the timer expires, the pending snapshot is cancelled and a new 30s countdown starts for the new context.
2. **Send/discard click** → `maybeSnapshot()` fires immediately in the capture-phase click handler (before Outlook processes the click, so compose DOM is still intact).

### Deduplication

`Set<string>` of content hashes (FNV-1a fingerprint of subject + recipients + first 2KB of body). If the hash has been seen before in this adapter lifetime, the snapshot is skipped entirely. No per-context reset needed — the Set accumulates globally so revisiting the same email doesn't re-snapshot.

```typescript
const seenContentHashes = new Set<string>();

function snapshotFingerprint(p: OutlookContentPayload): string {
    return shortHash(p.subject + p.to.join(",") + p.body.slice(0, 2000));
}

function maybeSnapshot() {
    const payload = extractSnapshot();
    if (!payload) return;
    const fp = snapshotFingerprint(payload);
    if (seenContentHashes.has(fp)) return;
    seenContentHashes.add(fp);
    sink({ type: "outlook.content", timestamp: Date.now(), context: effectiveCtx(), payload });
}

function scheduleSnapshot() {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => { snapshotTimer = null; maybeSnapshot(); }, 30_000);
}
```

---

## Adapter-specific events

Beyond the standard Tap events (keystrokes, clicks, scroll, etc.) which flow through with rewritten contexts, the adapter injects Outlook-specific captures.

### `outlook.navigate` (implemented)

Emitted when the URL changes within the SPA (Layer 1) or when the DOM-layer context changes — compose pane open/close (Layer 2).

Emitted on every context change, including transitions to/from `other` (unsupported paths). This ensures the bundler always sees the full navigation flow.

```typescript
{
    type: "outlook.navigate",
    timestamp: number,
    context: string,         // new context after navigation
    payload: {
        folder: string,      // "inbox" | "sent" | "drafts" | "compose" | "reply" | "forward"
        messageId: string | null,
        previousContext: string,
    }
}
```

Currently in `types.ts` as `OutlookNavigatePayload` and in the `Capture` union.

### `outlook.content` (implemented)

Structured email snapshot. See [outlook.content section above](#outlookcontent--email-snapshot-implemented).

### `outlook.send` (implemented)

Emitted when an email is sent.

```typescript
{
    type: "outlook.send",
    timestamp: number,
    context: string,         // the compose context being sent, e.g. "reply:a8f3k2"
    payload: {
        mode: "compose" | "reply" | "forward",
        draftId: string | null,
    }
}
```

Detection: delegated click listener on `button[aria-label="Send"]` or `[data-testid="ComposeSendButton"]`. Fallback: compose pane disappears without a Discard click → infer send.

### `outlook.discard` (implemented)

Emitted when a draft is discarded (compose abandoned without sending).

```typescript
{
    type: "outlook.discard",
    timestamp: number,
    context: string,
    payload: {
        mode: "compose" | "reply" | "forward",
        draftId: string | null,
    }
}
```

Detection: click on `button#discardCompose` or `button[aria-label="Discard"]`. Title attribute: `"Discard (Esc)"`.

---

## Detection strategies

### Send detection

Multiple signals combined for reliability:

1. **Send button click** — delegated click listener on `document`, matching `button[aria-label="Send"]` or ancestor `[data-testid="ComposeSendButton"]`. The send button is a FluentUI `SplitButton` with `title="Send (Ctrl+Enter)"`.

2. **Context transition** — if the compose pane disappears (DOM layer clears) and no discard was detected, infer a send.

3. **DOM removal** — `MutationObserver` watching for the compose editor (`div[aria-label="Message body"][contenteditable="true"]`) being removed from the DOM.

Priority: button click (most reliable) → DOM removal + no discard (fallback).

### Discard detection

1. **Discard button click** — `button#discardCompose` or `button[aria-label="Discard"]` with `title="Discard (Esc)"`.
2. **Context transition from compose without send** — if compose context ends and no send was detected, emit discard.

### Selector resilience

Outlook Web's DOM is obfuscated and class names change frequently. Selectors should:

- Prefer `aria-label`, `role`, `data-testid`, and element `id` attributes over class names
- Use multiple fallback selectors per action
- Log when no selector matches (dev channel) so we can update quickly
- Known stable IDs: `discardCompose` (discard button), `UniqueMessageBody_*` (read body), `MSG_*_SUBJECT` (subject input)
- Known stable `data-testid`: `ComposeSendButton`
- Known stable `aria-label` values: `"Send"`, `"Discard"`, `"Subject"`, `"Message body"`, `"To"`, `"Cc"`, `"Bcc"`, `"From: <name>"`

---

## Payloads (types.ts)

Implemented:

```typescript
export interface OutlookNavigatePayload {
    folder: string;
    messageId: string | null;
    previousContext: string;
}

export interface OutlookSendPayload {
    mode: "compose" | "reply" | "forward";
    draftId: string | null;
}

export interface OutlookDiscardPayload {
    mode: "compose" | "reply" | "forward";
    draftId: string | null;
}
```

Implemented:

```typescript
export interface OutlookContentPayload {
    mode: "read" | "compose" | "reply" | "forward";
    subject: string;
    from: string | null;
    to: string[];
    cc: string[];
    bcc: string[];
    body: string;
    attachments: string[];
    draftId: string | null;
}
```

In `Capture` union:

```typescript
| BaseCapture<"outlook.navigate", OutlookNavigatePayload>
| BaseCapture<"outlook.send", OutlookSendPayload>
| BaseCapture<"outlook.discard", OutlookDiscardPayload>
| BaseCapture<"outlook.content", OutlookContentPayload>
```

---

## Teardown

```typescript
return () => {
    clearInterval(pollTimer);          // URL poll interval
    ac.abort();                        // popstate + click listeners
    composeObserver.disconnect();      // MutationObserver for compose pane
    cancelSettle();                    // navigation settle timer
    if (settleTimer) clearTimeout(settleTimer); // compose detection debounce
    if (snapshotTimer) clearTimeout(snapshotTimer); // content snapshot countdown
    teardownInner();                   // inner tap cleanup
};
```

---

## Registry

Single consolidated route entry in `src/event/registry.ts`:

```typescript
{
    match: (url) =>
        /outlook\.office\.com\/mail\//.test(url) ||
        /outlook\.(com|live\.com)\/mail\//.test(url),
    build: () => relay(normalizer(outlookAdapter(tap()))),
},
```

---

## File map

| File                            | Role                                             | Status      |
| ------------------------------- | ------------------------------------------------ | ----------- |
| `src/event/adapters/outlook.ts` | Adapter — URL parsing, context rewriting, events | Implemented |
| `src/event/types.ts`            | `Outlook*Payload` interfaces + Capture union     | Implemented |
| `src/event/registry.ts`         | Route entry                                      | Implemented |

---

## Dev panel verification

1. Filter on the `adapter` channel:

   1. Navigate to inbox → see `outlook.navigate` with `context: "inbox"`, `folder: "inbox"`
   2. Open an email → see `outlook.navigate` with `context: "inbox:k7f2m9x"`, `messageId` populated
   3. Type in the email view → see `input.keystroke` captures with `context: "inbox:k7f2m9x"` (rewritten from `"root"`)
   4. Navigate to sent items → see `outlook.navigate` with `context: "sent"`
   5. Open a sent email → see `outlook.navigate` with `context: "sent:p4n9t3r"`
   6. Navigate to drafts → see `outlook.navigate` with `context: "drafts"`
   7. Navigate to deleted/junk/archive → see `outlook.navigate` with `context: "other"`, captures still flow
   8. Navigate back/forward → see `outlook.navigate` from popstate/poll

2. After Layer 2 is implemented:

    1. Click Reply on an inbox email → see `outlook.navigate` with `context: "reply:a8f3k2"` (DOM-detected)
    2. Type in compose editor → see `input.keystroke` captures with `context: "reply:a8f3k2"`
    3. Click Forward → see `outlook.navigate` with `context: "forward:b7c4d9"` (DOM-detected)
    4. Click Send → see `outlook.send`, followed by `outlook.navigate` reverting to read context
    5. Open new compose → see `outlook.navigate` with `context: "compose:m4p9w1"` (different draft hash)
    6. Click Discard → see `outlook.discard`, followed by `outlook.navigate` reverting to read context
