# Outlook Adapter

Domain-specific adapter for Outlook Web (`outlook.office.com`, `outlook.live.com`). Registers each email as its own source by deriving a **dynamic context** from the URL, enabling per-email time tracking and event attribution.

## Pipeline

```bash
tap() → outlookAdapter() → normalizer() → relay()
```

## Core concept: per-email source registration

Unlike the HTML or file adapters which use a static `context: "root"`, the Outlook adapter **rewrites the context on every capture** based on the current URL. The aggregator then combines it with `tabId` to form the source:

```text
User opens email A → URL: /mail/inbox/id/AAkALg...VAAA
  → adapter parses URL → context = "inbox:k7f2m9x1"
  → aggregator stamps  → source  = "inbox:k7f2m9x1@142"

User opens email B → URL: /mail/inbox/id/BBkXMp...QAAA
  → adapter parses URL → context = "inbox:m3p8q2w5"
  → aggregator stamps  → source  = "inbox:m3p8q2w5@142"
  → bundler sees new source → source transition → new bundle
```

Each distinct context creates a distinct source. Navigating between emails triggers a source transition in the bundler automatically.

---

## URL parsing

Outlook Web is an SPA. All navigation happens within a single page load. The adapter parses `window.location.pathname` to extract the **folder** and **message ID**.

### URL patterns

| URL pattern                  | Folder    | Context example  | Description         |
| ---------------------------- | --------- | ---------------- | ------------------- |
| `/mail/`                     | —         | `lobby`          | Landing / no email  |
| `/mail/inbox/`               | `inbox`   | `inbox`          | Inbox list          |
| `/mail/inbox/id/{id}`        | `inbox`   | `inbox:<hash>`   | Reading inbox email |
| `/mail/sentitems/`           | `sent`    | `sent`           | Sent items list     |
| `/mail/sentitems/id/{id}`    | `sent`    | `sent:<hash>`    | Viewing sent email  |
| `/mail/drafts/`              | `drafts`  | `drafts`         | Drafts list         |
| `/mail/drafts/id/{id}`       | `drafts`  | `drafts:<hash>`  | Editing a draft     |
| `/mail/deleteditems/`        | `deleted` | `deleted`        | Deleted items list  |
| `/mail/deleteditems/id/{id}` | `deleted` | `deleted:<hash>` | Viewing deleted     |
| `/mail/junkemail/`           | `junk`    | `junk`           | Junk list           |
| `/mail/junkemail/id/{id}`    | `junk`    | `junk:<hash>`    | Viewing junk email  |
| `/mail/archive/`             | `archive` | `archive`        | Archive list        |
| `/mail/archive/id/{id}`      | `archive` | `archive:<hash>` | Viewing archive     |
| `/mail/compose/{id}`         | —         | `compose:<hash>` | Composing email     |
| `/mail/deeplink/compose`     | —         | `compose`        | New compose (no ID) |
| `/mail/search/rp/{id}`       | `search`  | `search:<hash>`  | Search result email |

### Parse function

```typescript
interface OutlookRoute {
    folder: string;           // "inbox" | "sent" | "drafts" | "compose" | "lobby" | ...
    messageId: string | null; // raw encoded ID from URL, null for list/lobby views
}

function parseOutlookUrl(pathname: string): OutlookRoute
```

Regex: `/\/mail\/(?:([a-z]+)\/(?:id\/(.+)|rp\/(.+))?)?/`

Folder name mapping (URL segment → context folder):

| URL segment    | Context folder |
| -------------- | -------------- |
| `inbox`        | `inbox`        |
| `sentitems`    | `sent`         |
| `drafts`       | `drafts`       |
| `deleteditems` | `deleted`      |
| `junkemail`    | `junk`         |
| `archive`      | `archive`      |
| `compose`      | `compose`      |
| `search`       | `search`       |
| `deeplink`     | `compose`      |
| *(none)*       | `lobby`        |

### Context format

```text
<folder>            — list view or lobby (no specific email)
<folder>:<hash>     — specific email within a folder
```

Full source (after aggregator stamps): `<folder>:<hash>@<tabId>`

Examples:

| URL                            | Context           | Source (tab 142)      |
| ------------------------------ | ----------------- | --------------------- |
| `/mail/`                       | `lobby`           | `lobby@142`           |
| `/mail/inbox/`                 | `inbox`           | `inbox@142`           |
| `/mail/inbox/id/AAk...VAAA`    | `inbox:k7f2m9x`   | `inbox:k7f2m9x@142`   |
| `/mail/compose/AAk...rAAA`     | `compose:m3p8q2w` | `compose:m3p8q2w@142` |
| `/mail/sentitems/id/BBx...QAA` | `sent:p4n9t3r`    | `sent:p4n9t3r@142`    |
| `/mail/deeplink/compose`       | `compose`         | `compose@142`         |

### Hash function

Message IDs are long URL-encoded strings (e.g. `AAkALgAAAAAAHYQDEapmEc2byACqAC%2FEWg0AX0WoIDuRA0umSY1YdRNbygAAS3L4VAAA`). The adapter hashes them to a short, deterministic, collision-resistant string.

**Algorithm**: FNV-1a (32-bit) → base36 → 7 characters

```typescript
function shortHash(messageId: string): string {
    let h = 0x811c9dc5;               // FNV offset basis
    for (let i = 0; i < messageId.length; i++) {
        h ^= messageId.charCodeAt(i);
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

---

## Internal navigation tracking

Since Outlook is an SPA and all its URLs match the same Route, the SPA observer in `content/main.ts` will **not** rebuild the pipeline on internal navigation. The adapter must detect URL changes itself.

### Strategy

The adapter maintains `lastPath: string` and detects changes via two mechanisms:

1. **Reactive (on capture)** — every time the inner tap emits a capture, the adapter checks `location.pathname`. If it changed, the adapter emits an `outlook.navigate` event *before* forwarding the capture with the new context.

2. **Proactive (popstate + polling)** — a `popstate` listener catches back/forward navigation. A 300 ms poll catches pushState/replaceState changes that don't generate captures (e.g. user navigates but doesn't interact). The poll is cheap — single string comparison per tick.

```text
inner capture arrives
    │
    ├─ pathname changed?
    │   ├── YES → emit outlook.navigate, update lastPath, forward with new context
    │   └── NO  → forward with current context
    │
    ▼
sink(capture)
```

On URL change without captures (poll / popstate):

```text
poll tick / popstate fires
    │
    ├─ pathname changed?
    │   ├── YES → emit outlook.navigate, update lastPath
    │   └── NO  → no-op
```

This ensures the aggregator registers the new source immediately, even if the user hasn't interacted after navigation.

---

## Context rewriting

The adapter wraps the inner Tap and rewrites `context` on every forwarded capture:

```typescript
const teardownInner = inner((capture) => {
    const ctx = resolveContext(); // parse current URL → "inbox:k7f2m9x" etc.
    sink({ ...capture, context: ctx });
});
```

This is the mechanism that "registers" each email as its own source. No changes to `tap.ts` or the aggregator are needed — the adapter is the only component that needs to understand Outlook URL structure.

---

## Adapter-specific events

Beyond the standard Tap events (keystrokes, clicks, scroll, etc.) which flow through with rewritten contexts, the adapter injects Outlook-specific captures.

### `outlook.navigate`

Emitted when the URL changes within the SPA — folder change, email open/close, compose enter/exit.

```typescript
{
    type: "outlook.navigate",
    timestamp: number,
    context: string,         // new context after navigation
    payload: {
        folder: string,      // "inbox" | "sent" | "compose" | "lobby" | ...
        messageId: string | null,
        previousContext: string,
    }
}
```

This ensures the aggregator sees the new source immediately, triggering a bundle transition even if no user interaction follows.

### `outlook.send`

Emitted when an email is sent.

```typescript
{
    type: "outlook.send",
    timestamp: number,
    context: string,         // the compose context being sent, e.g. "compose:m3p8q2w"
    payload: {
        folder: "compose",
        messageId: string | null,
    }
}
```

### `outlook.discard`

Emitted when a draft is discarded (compose abandoned without sending).

```typescript
{
    type: "outlook.discard",
    timestamp: number,
    context: string,
    payload: {
        folder: "compose",
        messageId: string | null,
    }
}
```

### `outlook.reply`

Emitted when a reply, reply-all, or forward is initiated from a reading view, transitioning the user into compose mode.

```typescript
{
    type: "outlook.reply",
    timestamp: number,
    context: string,         // the read context where action was initiated
    payload: {
        action: "reply" | "reply_all" | "forward",
        sourceFolder: string,    // "inbox", "sent", etc.
        sourceMessageId: string | null,
    }
}
```

---

## Detection strategies

### Send detection

Multiple signals combined for reliability:

1. **Send button click** — observe clicks on elements matching Outlook's send button selectors (`[aria-label="Send"]`, `button[title="Send"]`, or the known `data-*` attributes). The adapter registers a delegated click listener on `document`.

2. **Context transition** — if the context was `compose:<hash>` and changes to a non-compose context without a discard signal, infer a send. This is a fallback for cases where the button selector changes.

3. **DOM removal** — a `MutationObserver` watching for the compose pane's root element being removed from the DOM. Combined with the context being `compose:*`, this confirms the compose session ended.

Priority: button click (most reliable) → DOM removal + context transition (fallback).

### Discard detection

1. **Discard button click** — `[aria-label="Discard"]` or similar.
2. **Context transition from compose without send** — if compose context ends and no send was detected, emit discard.

### Reply / Forward detection

1. **Button click** — reply (`[aria-label="Reply"]`), reply all (`[aria-label="Reply all"]`), forward (`[aria-label="Forward"]`).
2. **Context transition to compose** — if the previous context was a read view and the new context is compose, correlate with the most recent reply/forward button click.

### Selector resilience

Outlook Web's DOM is obfuscated and changes frequently. Selectors should:

- Prefer `aria-label` and `role` attributes over class names or IDs
- Use multiple fallback selectors per action
- Log when no selector matches (dev channel) so we can update quickly

---

## Payloads (types.ts additions)

```typescript
// ── outlook adapter payloads ───────────────────────────────────────

export interface OutlookNavigatePayload {
    folder: string;
    messageId: string | null;
    previousContext: string;
}

export interface OutlookSendPayload {
    folder: "compose";
    messageId: string | null;
}

export interface OutlookDiscardPayload {
    folder: "compose";
    messageId: string | null;
}

export interface OutlookReplyPayload {
    action: "reply" | "reply_all" | "forward";
    sourceFolder: string;
    sourceMessageId: string | null;
}
```

Add to `Capture` union:

```typescript
| BaseCapture<"outlook.navigate", OutlookNavigatePayload>
| BaseCapture<"outlook.send", OutlookSendPayload>
| BaseCapture<"outlook.discard", OutlookDiscardPayload>
| BaseCapture<"outlook.reply", OutlookReplyPayload>
```

Add corresponding `BaseEvent` variants to `SessionEvent`.

---

## Teardown

```typescript
return () => {
    ac.abort();                       // AbortController: send/discard/reply click listeners
    clearInterval(pollTimer);         // URL poll interval
    if (observer) observer.disconnect(); // MutationObserver for compose pane removal
    teardownInner();                  // inner tap cleanup
};
```

---

## File map

| File                                 | Role                                               |
| ------------------------------------ | -------------------------------------------------- |
| `src/event/adapters/outlook.ts`      | Adapter — URL parsing, context rewriting, events   |
| `src/event/adapters/outlook-urls.ts` | URL parser + hash function (pure, testable)        |
| `src/event/types.ts`                 | Payload types + Capture/SessionEvent union entries |
| `src/event/registry.ts`              | Route entry (already exists)                       |

---

## Registry note

The current registry has two Outlook-matching entries:

```typescript
// Entry 1: matches outlook.com / outlook.live.com (broad)
{ match: (url) => /outlook\.(com|live\.com)/.test(url), build: ... }

// Entry 3: matches outlook.office.com/mail/ (specific, unreachable)
{ match: (url) => url.startsWith("https://outlook.office.com/mail/"), build: ... }
```

Entry 3 is unreachable because Entry 1 matches first. This should be consolidated — Entry 1 is the correct match for the Outlook adapter.

---

## Dev panel verification

Filter on the `adapter` channel:

1. Navigate to inbox → see `outlook.navigate` with `context: "inbox"`, `folder: "inbox"`
2. Open an email → see `outlook.navigate` with `context: "inbox:k7f2m9x"`, `messageId` populated
3. Type a reply → see `input.keystroke` captures with `context: "inbox:k7f2m9x"` (rewritten)
4. Click Reply → see `outlook.reply` with `action: "reply"`
5. Compose pane opens → see `outlook.navigate` with `context: "compose:m3p8q2w"`
6. Click Send → see `outlook.send`, followed by `outlook.navigate` as context changes
7. Navigate back/forward → see `outlook.navigate` from popstate/poll

---

## Open questions

1. **Inline reply vs. full compose** — Outlook supports inline reply (reply pane within the reading view) and full-screen compose. Inline reply doesn't change the URL. Should we detect this via DOM observation and create a sub-context like `inbox:k7f2m9x.reply`? Or treat it as part of the read context?

2. **Calendar/People/Tasks views** — Outlook Web also has `/calendar/`, `/people/`, and `/tasks/` routes. These are different apps within the Outlook shell. Should the adapter handle them with their own folder contexts, or should separate adapters be created?

3. **Multi-account** — Outlook supports switching between accounts in the same tab. The account identifier doesn't appear in the URL path. Should we detect account switches (via DOM observation of the account switcher) and namespace the context?

4. **Conversation vs. individual message** — Outlook can display email threads as conversations. When viewing a conversation, the URL points to one message but the view shows multiple. Should the context reflect the conversation or the individual message?

5. **Reading pane layout** — Outlook can show the reading pane to the right of the list (split view) or as a full page. In split view, the email content is visible without a URL change. How should this be handled?
