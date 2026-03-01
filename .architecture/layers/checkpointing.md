# Checkpointing

```text
┌─ chrome.storage.local ──────────────────────────────────────────────────┐
│                                                                         │
│  ┌─ Checkpoint: Aggregator State ──────────────────────────────────────┐│
│  │  key: "checkpoint"                                                  ││
│  │  value: { openBundle, sealed[], transitions[], activeSource,        ││
│  │           savedAt }                                                 ││
│  │  written: every 50 sealed bundles                                   ││
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

## Checkpointing Overview

Chrome can kill the service worker at any time (idle timeout, update, crash). The browser itself can close without warning. Checkpointing ensures no data is silently lost by writing the [Aggregator's](./aggregation.md) in-memory state to `chrome.storage.local`.

**What gets checkpointed:**

- The open Bundle (if any) — full `Bundle` with all `BundleEntry` captures
- All sealed Bundles not yet flushed
- The raw transition log
- The active source

**When it gets checkpointed:**

- Every 50 sealed bundles
- On `chrome.runtime.onSuspend` (Chrome signals the service worker is about to be killed — best-effort, not guaranteed)

**Recovery scenarios:**

1. **Service worker restarts** (killed by Chrome, extension updated, etc.) — on startup, read the checkpoint from `chrome.storage.local`. Restore `openBundle`, `sealed[]`, `transitions[]`, `activeSource`. Resume as if nothing happened. Events that arrived between the last checkpoint and the kill are lost — this is an acceptable trade-off for simplicity.

2. **Browser closed abruptly** (crash, force quit, shutdown) — on next browser launch, the service worker starts, reads the checkpoint. The stale open Bundle is sealed (its `endedAt` set to the timestamp of its last capture). All sealed Bundles are flushed into a Packet and synced. This Packet represents the tail end of the previous session.

3. **Sync failure** — the Packet goes to the RetryQueue (already in `chrome.storage.local`). On startup, the RetryQueue is drained before normal operation resumes.

## Checkpoint Type

```typescript
type Checkpoint = {
  activeSource: string | null;
  openBundle: Bundle | null;
  sealed: Bundle[];
  transitions: Transition[];
  savedAt: number;
};
```

## Example: Checkpointing

```typescript
let sealedSinceCheckpoint = 0;
const CHECKPOINT_EVERY_N_SEALED = 50;

/** Called by the Bundler every time a bundle is sealed. */
function maybeCheckpoint(): void {
  sealedSinceCheckpoint++;
  if (sealedSinceCheckpoint >= CHECKPOINT_EVERY_N_SEALED) {
    checkpoint();
  }
}

async function checkpoint(): Promise<void> {
  sealedSinceCheckpoint = 0;
  const data: Checkpoint = {
    activeSource,
    openBundle,
    sealed: [...sealed],
    transitions: [...transitions],
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
  transitions.push(...cp.transitions);

  if (cp.openBundle) {
    // seal the stale open bundle — use the timestamp of its last capture
    // as the best estimate of when it actually ended
    const lastCapture = cp.openBundle.captures.at(-1);
    cp.openBundle.endedAt = lastCapture?.timestamp ?? cp.savedAt;
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

## Checkpoint on suspend

`chrome.runtime.onSuspend` fires when Chrome is about to kill the service worker. Use it as a last-chance checkpoint:

```typescript
chrome.runtime.onSuspend.addListener(() => {
  checkpoint();
});
```

## Checkpoint dev logs

All checkpoint logs use the `"checkpoint"` dev channel. See the [Development Layer](./development.md) for the full dev logging system.

| Event                  | When                                           | Data                                                                  |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| `checkpoint.written`   | Checkpoint saved to `chrome.storage.local`     | `{ sealed: number, transitions: number, hasOpenBundle: boolean }`     |
| `checkpoint.suspend`   | `onSuspend` triggered a last-chance checkpoint | `{ sealed: number, transitions: number, hasOpenBundle: boolean }`     |
| `checkpoint.recovered` | Checkpoint restored on startup                 | `{ sealed: number, transitions: number, staleBundleSealed: boolean }` |
| `checkpoint.cleared`   | Checkpoint removed after successful recovery   | `{}`                                                                  |
