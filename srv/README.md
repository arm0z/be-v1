# Sink Server Architecture

The sink server (`srv/main.py`) is a development packet viewer that receives,
stores, and displays `Packet` payloads produced by the packer
(`src/aggregation/packer.ts`).

---

## Purpose

The packer groups browser activity into community-detected groups and
periodically flushes them as `Packet` objects. The sink server is the receiving
end — it persists every packet in SQLite and provides a web UI to inspect the
grouping results, edges, bundles, and translated text.

It is not a production backend. It is a **development tool** for:

- Verifying that the packer produces well-formed packets
- Inspecting community grouping quality (which sources ended up together)
- Reading the translated bundle text (the human-readable activity log)
- Checking edge weights and graph structure
- Debugging sync failures and retry behaviour

---

## Quick Start

```bash
cd srv
uv run main.py
```

Listens on `http://localhost:5000` (configurable via `PORT` env var).

The extension sends packets to `POST /api/v1/extension/sync` automatically
on periodic (2h) and idle (10min) triggers. You can also trigger a manual
sync from the dev panel with the `sync.send` command.

---

## Packet Wire Format

The extension (`src/sync/index.ts:20-34`) sends the Packet as a JSON POST:

```bash
POST /api/v1/extension/sync
Content-Type: application/json
Authorization: Bearer {token}

{
  "id":        "uuid-v4",
  "createdAt": 1709299600000,
  "groups":    [ ...Group[] ],
  "edges":     [ ...Edge[] ]
}
```

### Group

```json
{
  "id": "community-id | singleton:{source} | hub:{source}:{chunk}",
  "bundles": [ ...Bundle[] ],
  "text": "concatenated translated text from all bundles",
  "meta": {
    "sources": ["context@tabId", ...],
    "tabs":    ["tabId", ...],
    "timeRange": { "start": 1709299600000, "end": 1709299900000 }
  }
}
```

**Group ID formats** (assigned by `packer.ts:assignBundles`):

- **Community ID**: Louvain-assigned community identifier (opaque string).
  Means this group was detected as a coherent cluster of activity.
- **`singleton:{source}`**: Source that was either transient (excluded by
  preprocessing), had no transitions (isolated), or was a hub with no
  matching chunk in the Louvain result.
- **`hub:{source}:{chunkIndex}`**: Mapped through the hub chunking system —
  a high-degree source split into time windows, then assigned to a community.

### Bundle

```json
{
  "source":    "context@tabId",
  "startedAt": 1709299600000,
  "endedAt":   1709299620000,
  "text":      "translated human-readable activity text",
  "captures":  [ ...BundleEntry[] ]
}
```

`text` is produced by `translate.ts` — converts raw captures into lines like
`type "hello"`, `click "Submit" /login`, `nav "Dashboard" https://...`, etc.

`captures` contains the raw stamped events (clicks, keystrokes, scrolls,
navigation, page content, outlook emails, etc.). Each entry has a `type`
field (e.g. `input.keystroke_batch`, `html.content`, `outlook.content`).

### Edge

```json
{
  "from":   "source-id",
  "to":     "source-id",
  "weight": 5
}
```

Edges are extracted from the directed graph built during preprocessing
(`packer.ts:graphToEdges`). Source IDs may include hub chunk rewrites
(e.g. `hub:gmail@42:0`) since edges come from the preprocessed graph.

---

## Storage

SQLite database at `srv/data.db` with WAL mode.

```sql
CREATE TABLE packets (
    id          TEXT PRIMARY KEY,   -- row UUID (server-generated)
    packet_id   TEXT NOT NULL,      -- packet.id from packer
    received_at TEXT NOT NULL,      -- ISO8601 server receive time
    payload     TEXT NOT NULL       -- full JSON packet as string
);
CREATE INDEX idx_packet_id ON packets(packet_id);
```

Packets are stored as-is — no transformation or field extraction. All
display logic parses the JSON on read.

---

## Routes

### `POST /api/v1/extension/sync`

**File**: `main.py:129-153`

Receives a Packet JSON body. Stores it in SQLite. Returns `{"status":"ok","id":"row-uuid"}`.

Returns 400 if the body is not valid JSON.

### `GET /`

**File**: `main.py:164-230`

Packet list page. Shows all received packets newest-first with columns:
Received, Packet ID (link), Groups, Bundles, Edges, Time Span.

### `GET /<row_id>`

**File**: `main.py:233-423`

Packet detail page. Shows:

- **Metadata**: row ID, packet ID, timestamps, counts, all sources and tabs
- **Edges**: collapsible table sorted by weight descending (From → To | Weight)
- **Groups**: one card per group showing:
  - Group header: index, ID prefix, bundle/tab counts, duration, time span
  - Metadata table: sources, tabs, span, duration
  - Merged text with token estimate and copy button
  - Collapsible bundle list with per-bundle source, time range, capture count,
    token estimate, and expandable text content

### `GET /<row_id>/json`

**File**: `main.py:426-445`

Raw JSON export of the stored packet.

### `POST /clear`

**File**: `main.py:156-161`

Deletes all stored packets. Redirects to `/`.

---

## Data Flow

```text
Bundler (captures → bundles + transitions)
    ↓
Packer (preprocess → graph → louvain → assign → Packet)
    ↓
sync/index.ts (POST JSON to /api/v1/extension/sync)
    ↓  (retry queue on failure, 7-day TTL, max 50 entries)
    ↓
srv/main.py (store in SQLite, render HTML)
```

---

## Dependencies

- `flask>=3.0` — web framework
- `ruff>=0.15.4` — linter/formatter (dev)
- Python 3.12+
- SQLite 3 (bundled with Python)
- Tailwind CSS via CDN (no build step)

---

## Configuration

| Env var | Default | Purpose          |
| ------- | ------- | ---------------- |
| `PORT`  | `5000`  | HTTP listen port |

No other configuration. CORS is open (`*`), debug mode is on, no auth
validation (token is accepted but not checked).
