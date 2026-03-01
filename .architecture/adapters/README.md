# How to Add an Adapter

An adapter is middleware with the signature `(inner: Tap) => Tap`. It sits between the base Tap (DOM event hooks) and the Normalizer in the content-script pipeline, and can inject new captures, filter/rewrite existing ones, or both.

Adding an adapter touches **4 files across 3 directories**:

| #   | File                           | What you add                             |
| --- | ------------------------------ | ---------------------------------------- |
| 1   | `src/event/types.ts`           | Payload interface + Capture union member |
| 2   | `src/event/adapters/<name>.ts` | Adapter implementation                   |
| 3   | `src/event/registry.ts`        | Route with `match` and `build`           |
| 4   | `src/aggregation/translate.ts` | Human-readable translation case          |

---

## Step 1: Define the payload and event type

**File**: `src/event/types.ts`

### 1a. Create the payload interface

Add it in the `// adapter-specific payloads` section (after line 208), alongside the existing `HTMLContentPayload`, `FileContentPayload`, and `OutlookNavigatePayload`:

```typescript
export interface MyDomainPayload {
    someField: string;
    // ...
}
```

### 1b. Add to the Capture union

Add a new `BaseCapture` member in the `// Adapter-specific` block of the `Capture` union (after line 285):

```typescript
export type Capture =
    // ...existing members...
    // Adapter-specific
    | BaseCapture<"html.content", HTMLContentPayload>
    | BaseCapture<"file.content", FileContentPayload>
    | BaseCapture<"outlook.navigate", OutlookNavigatePayload>
    | BaseCapture<"mydomain.action", MyDomainPayload>;  // ← new
```

### 1c. Export a const for the type string

This goes in your adapter file (step 2), not in types.ts — but decide the name now:

```typescript
export const MY_EVENT = "mydomain.action" as const;
```

**Naming convention**: `domain.action` — e.g. `html.content`, `file.content`, `outlook.navigate`.

---

## Step 2: Implement the adapter

**File**: `src/event/adapters/<name>.ts`

Every adapter follows this skeleton:

```typescript
import type { Adapter, MyDomainPayload } from "../types.ts";
import { dev } from "../dev.ts";

export const MY_EVENT = "mydomain.action" as const;
export type { MyDomainPayload };

export const myAdapter: Adapter = (inner) => {
    return (sink) => {
        // setup: listeners, observers, timers...

        const teardownInner = inner(sink); // or inner(wrappedSink)

        return () => {
            // cleanup: abort, disconnect, clearTimeout/Interval...
            teardownInner();
        };
    };
};
```

### Three archetypes

Pick the pattern that matches your use case. All three are live in the codebase.

#### Injecting (html.ts pattern)

Adds new captures alongside the pass-through stream. The inner tap flows through unchanged; the adapter injects additional captures by calling `sink()` directly.

```typescript
// src/event/adapters/html.ts — simplified
export const htmlAdapter: Adapter = (inner) => {
    return (sink) => {
        // inject adapter-specific captures
        sink({ type: HTML_CONTENT, timestamp: Date.now(), context: "root", payload: { ... } });

        // pass through inner captures unchanged
        const teardownInner = inner(sink);
        return () => { teardownInner(); };
    };
};
```

Key detail: `inner(sink)` — the same sink receives both inner captures and injected ones.

#### Filtering / rewriting (outlook.ts pattern)

Wraps the sink to intercept every inner capture before forwarding. Can drop, transform, or annotate captures.

```typescript
// src/event/adapters/outlook.ts — simplified
export const outlookAdapter: Adapter = (inner) => {
    return (sink) => {
        let currentCtx = resolveContext();

        // wrap sink to rewrite context on every capture
        const teardownInner = inner((capture) => {
            sink({ ...capture, context: currentCtx });
        });

        // also inject adapter-specific captures
        sink({ type: "outlook.navigate", timestamp: Date.now(), context: currentCtx, payload: { ... } });

        return () => { teardownInner(); };
    };
};
```

Key detail: `inner((capture) => { ... })` — the wrapper function intercepts before forwarding.

#### One-shot (file.ts pattern)

Emits a single capture on load. No ongoing listeners, minimal teardown.

```typescript
// src/event/adapters/file.ts — simplified
export const fileAdapter: Adapter = (inner) => {
    return (sink) => {
        const teardownInner = inner(sink);

        // one-shot: read and emit
        sink({ type: FILE_CONTENT, timestamp: Date.now(), context: "root", payload: { ... } });

        return () => { teardownInner(); };
    };
};
```

### Dev logging

Use `dev.log()` for adapter diagnostics. No registration needed — just call it:

```typescript
dev.log("adapter", MY_EVENT, "descriptive message", { key: value });
```

- **Channel**: `"adapter"` (filter in the dev panel)
- **Event**: your const (e.g. `MY_EVENT`)
- **Message**: short human string
- **Data**: arbitrary object for inspection

### Teardown

Clean up everything: listeners, timers, observers. Use `AbortController` for event listeners:

```typescript
const ac = new AbortController();
document.addEventListener("scroll", handler, { signal: ac.signal });

return () => {
    ac.abort();                           // removes all listeners using this signal
    if (observer) observer.disconnect();  // MutationObserver
    clearTimeout(debounceTimer);          // timers
    clearInterval(pollTimer);             // intervals
    teardownInner();                      // always last
};
```

---

## Step 3: Register the route

**File**: `src/event/registry.ts`

Import your adapter and add a `Route` to the `registry` array:

```typescript
import { myAdapter } from "./adapters/mydomain.ts";

export const registry: Route[] = [
    // ← specific routes first
    {
        match: (url) => url.includes("mydomain.com"),
        build: () => relay(normalizer(myAdapter(tap()))),
    },
    // ...existing routes...
    {
        // catch-all: generic web (must be last)
        match: () => true,
        build: () => relay(normalizer(htmlAdapter(tap()))),
    },
];
```

**Order matters**: first match wins. Place specific routes before the catch-all.

**Pipeline shape**: always `relay(normalizer(yourAdapter(tap())))`. The adapter wraps the tap; the normalizer wraps the adapter; the relay wraps everything.

**SPA behavior**: when the URL changes within a matched route, the pipeline is **not** rebuilt — the same Route stays alive and adapter state persists. If your domain is an SPA (like Outlook), handle internal navigation inside the adapter.

---

## Step 4: Add translate handler

**File**: `src/aggregation/translate.ts`

Add a `case` in the `translateEntry()` switch (line 50–125) to produce a human-readable string:

```typescript
function translateEntry(c: BundleEntry): string | null {
    switch (c.type) {
        // ...existing cases...

        case "mydomain.action":
            return `mydomain: ${truncate(c.payload.someField, 40)}`;

        default:
            return null;
    }
}
```

- Return a short, human-readable string describing what happened
- Return `null` to suppress the entry from translated output
- Use `truncate(str, length)` or `truncate(str, length, { fromCenter: true })` for long values
- Keep the format consistent: `"verb object"` or `"domain: description"`

---

## Step 5: Verify

1. Load the extension in dev mode
2. Navigate to a URL that matches your route
3. Open the dev page and filter on the `adapter` channel
4. Confirm your adapter-specific captures appear with correct payloads
5. Check that inner captures (keystrokes, clicks, etc.) still flow through
6. Navigate away and back — confirm teardown and re-setup work cleanly

---

## Checklist

| Step | File                           | Action                       | Verify            |
| ---- | ------------------------------ | ---------------------------- | ----------------- |
| 1a   | `src/event/types.ts`           | Add payload interface        | Types compile     |
| 1b   | `src/event/types.ts`           | Add to `Capture` union       | Types compile     |
| 2    | `src/event/adapters/<name>.ts` | Implement adapter            | Dev logs appear   |
| 3    | `src/event/registry.ts`        | Add route (before catch-all) | Route matches URL |
| 4    | `src/aggregation/translate.ts` | Add translate case           | Bundles show text |
| 5    | Dev page                       | End-to-end test              | All captures flow |
