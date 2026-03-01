# DevHub

Development-only UI for inspecting the service worker in real time. Only compiled when `import.meta.env.DEV` is true.

## Architecture

```bash
src/event/dev.ts          types + dev.log() helper
src/background/main.ts    DevHub host (log buffer, port listener, command handlers)
src/dev/
  useDevPort.ts           React hook — port connection, reconnect, batched state
  DevContext.tsx          React context that distributes port state to panels
  App.tsx                 Dockview shell (Graph, Log, Packet, Checkpoint panels)
  panels/                 individual panel components
```

### Connection

The devhub page connects to the service worker with `chrome.runtime.connect({ name: "dev" })`. The service worker keeps a `Set<Port>` and broadcasts entries to every connected port.

On connect the service worker sends two messages:

1. `{ type: "replay", entries }` — full log buffer (up to 10k entries)
2. `{ type: "filter", filter }` — current channel/event filter state

After that, each new dev log is pushed as `{ type: "entry", entry }`.

The React side (`useDevPort.ts`) batches incoming entries via `queueMicrotask` to avoid per-message re-renders.

### Message types

**Service worker -> devhub** (`DevMessage` in `src/background/main.ts:327`):

| type     | payload                   | when                                 |
| -------- | ------------------------- | ------------------------------------ |
| `replay` | `{ entries: DevEntry[] }` | on port connect                      |
| `entry`  | `{ entry: DevEntry }`     | each new dev.log call                |
| `filter` | `{ filter: DevFilter }`   | on connect + whenever filter changes |

**Devhub -> service worker** (`DevCommand` in `src/background/main.ts:332`):

| type               | payload                                              | effect                                                         |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| `setChannelFilter` | `{ channels: Partial<Record<DevChannel, boolean>> }` | toggles channel visibility, broadcasts new filter to all ports |
| `setEventFilter`   | `{ events: Partial<Record<string, boolean>> }`       | toggles event visibility, broadcasts new filter to all ports   |
| `sync.flush`       | _(none)_                                             | calls `packer.flush()`, logs result                            |
| `sync.send`        | _(none)_                                             | calls `flushAndSync()` (flush + upload)                        |
| `checkpoint.save`  | _(none)_                                             | calls `checkpointer.save()`                                    |
| `sync.drain_retry` | _(none)_                                             | calls `drainRetryQueue()`                                      |
| `state.reset`      | _(none)_                                             | clears logs, drains aggregator, wipes checkpoint + retry queue |

### Command handlers

Defined in the `port.onMessage.addListener` block inside the `if (import.meta.env.DEV)` guard in `src/background/main.ts`. The five action commands map directly to the sync/checkpoint functions defined earlier in the same file:

- **`sync.flush`** — packs the current aggregator state into a packet without uploading. Logs a `sync.flush` dev event with the packet (or "nothing to flush").
- **`sync.send`** — flush + upload. Delegates to `flushAndSync()` which packs, logs `packet.ready`, and calls `sync()`.
- **`checkpoint.save`** — persists sealed bundles to IndexedDB immediately (normally triggered every 50 seals or on suspend).
- **`sync.drain_retry`** — retries any packets that previously failed to upload (normally only runs once on startup after recovery).
- **`state.reset`** — nuclear reset. Clears the dev log buffer, flushes the aggregator (seal + drain), and removes both `checkpoint` and `retryQueue` keys from `chrome.storage.local`. The devhub client also clears its local entries.

### UI buttons

The action commands are exposed as buttons in the devhub panels:

**Packet panel** toolbar (left side) — `panels/PacketInspector.tsx`:

- **Flush** → `sync.flush` — pack aggregator state into a packet
- **Send** → `sync.send` — flush + upload

**Checkpoint panel** toolbar (next to refresh/clear) — `panels/CheckpointInspector.tsx`:

- **Save** → `checkpoint.save` — persist to storage now

**Graph panel** clear button (top-right trash icon) — `panels/GraphView.tsx`:

- **Clear all** → `state.reset` + local `clear()` — wipes everything

All panels receive an `onSend` prop threaded from `useDevPort().send` through `DevContext` and the panel wrappers in `App.tsx`.

### Sending commands from the console

With the devhub page open:

```js
// grab the port (useDevPort stores it in a ref, but you can also open a new one)
const port = chrome.runtime.connect({ name: "dev" });
port.postMessage({ type: "sync.flush" });
port.postMessage({ type: "sync.send" });
port.postMessage({ type: "checkpoint.save" });
port.postMessage({ type: "sync.drain_retry" });
port.postMessage({ type: "state.reset" });
```

### Dev log channels

Defined in `src/event/dev.ts` as `DevChannel`:

`tap` `adapter` `normalizer` `relay` `aggregator` `packer` `navigation` `sync` `checkpoint`

All channels are enabled by default. The filter toggles are persisted only for the service worker's lifetime.
