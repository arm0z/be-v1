# Syncing Layer

```text
┌─ Service Worker ────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌─ Sync Triggers ─────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  1. Periodic alarm: every 2 hours                                   ││
│  │  2. Off-browser idle: 10 minutes after leaving the browser          ││
│  │  3. Recovery: on service worker restart with stale checkpoint       ││
│  │  4. Suspend: chrome.runtime.onSuspend (best-effort)                 ││
│  │                                                                     ││
│  │  All triggers: packer.flush() → if packet → sync(packet)            ││
│  │                                                                     ││
│  └──────────────────────────────────────────────────┬──────────────────┘│
│                                                     │                   │
│                                                     ▼                   │
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

## Syncing Overview

The Syncing Layer takes a Packet from the [Aggregation Layer](./aggregation.md) and sends it to the server. The Packer builds the Packet; this layer handles delivery and retry.

- `POST /api/v1/extension/sync` with `Authorization: Bearer <token>` and the Packet as the JSON body.
- On success, done.
- On failure (network error, 5xx, etc.), the Packet is pushed to a **RetryQueue** persisted in `chrome.storage.local`. Retries with exponential backoff, drops entries older than a max age.

## Sync Triggers

Two `chrome.alarms` control when a flush + sync happens:

**1. Periodic (every 2 hours)** — a repeating alarm that fires regardless of activity. Covers the case where the user is actively browsing for extended periods, or bouncing on/off the browser in short stints (< 10 minutes each) that never trigger the idle flush.

**2. Off-browser idle (10 minutes)** — when the aggregator transitions to `off_browser` (user left the browser), a one-shot alarm is created with a 10-minute delay. If the user returns before it fires, the alarm is cancelled. If the 10 minutes elapse, the alarm fires, triggering a flush and sync.

```text
User leaves browser
        │
        ▼
  aggregator transitions to off_browser
        │
        ▼
  chrome.alarms.create("sync-idle", { delayInMinutes: 10 })
        │
        ├── user returns before 10m ──▶ chrome.alarms.clear("sync-idle")
        │                                (nothing happens)
        │
        └── 10 minutes elapse ──▶ alarm fires ──▶ flush() ──▶ sync()
```

After an idle flush, the 2-hour periodic alarm resets so there's no redundant flush shortly after the user returns.

`chrome.alarms` has a minimum granularity of ~1 minute in production, so "10 minutes" is approximate — this is acceptable.

## Example: Sync Trigger Setup

```typescript
const SYNC_PERIODIC_MINUTES = 120;  // 2 hours
const SYNC_IDLE_MINUTES = 10;       // 10 minutes off-browser

// Periodic alarm — repeats every 2 hours
chrome.alarms.create("sync-periodic", { periodInMinutes: SYNC_PERIODIC_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync-periodic" || alarm.name === "sync-idle") {
    const packet = packer.flush();
    if (packet) sync(packet);

    // reset the periodic alarm after an idle flush so we
    // don't get a redundant flush shortly after the user returns
    if (alarm.name === "sync-idle") {
      chrome.alarms.create("sync-periodic", { periodInMinutes: SYNC_PERIODIC_MINUTES });
    }
  }
});
```

The off-browser idle alarm is managed by the aggregator's transition callback:

```typescript
// When the aggregator transitions to off_browser:
chrome.alarms.create("sync-idle", { delayInMinutes: SYNC_IDLE_MINUTES });

// When the user returns (aggregator transitions away from off_browser):
chrome.alarms.clear("sync-idle");
```

## Syncing Types

```typescript
type SyncConfig = {
  syncUrl: string;       // "/api/v1/extension/sync"
  retryMaxAge: number;   // e.g. 7 days (ms)
};
```

## Example: Sender

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
