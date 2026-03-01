# Step 5: Create `preprocess.ts`

## Goal

Create `src/aggregation/preprocess.ts` — the preprocessing pipeline that filters and rewrites raw transitions before graph construction. Four stages: off-browser sentinel splitting, transient source removal, hub detection, and hub temporal chunking with dynamic window sizing.

## Prerequisites

Steps 1–4 complete. All types exist. The build passes cleanly.

## File to create

`src/aggregation/preprocess.ts`

## Specification reference

`.architecture/packer.md` sections:
- "Pre-processing" (lines ~183–377) — full algorithm description
- "Implementation specification → `src/aggregation/preprocess.ts`" — function signatures and constants
- "Constants" table — all threshold values

## Constants

Define these at the top of the file:

```typescript
const SENTINEL_PASSTHROUGH_MS = 2_000;       // 2 seconds
const SENTINEL_BREAK_MS = 600_000;           // 10 minutes
const TRANSIENT_DWELL_MS = 500;              // 500ms
const TRANSIENT_CHAIN_MS = 1_000;            // 1 second
const HUB_THRESHOLD_PERCENT = 0.1;           // 10%
const HUB_MIN_SOURCES = 15;
const TARGET_PER_CHUNK = 4;
const MIN_CHUNK_MS = 60_000;                 // 1 minute
const MAX_CHUNK_MS = 900_000;                // 15 minutes
```

## Imports

```typescript
import type { Transition, PreprocessResult, ChunkInfo } from "./types.ts";
import { OFF_BROWSER } from "./types.ts";
```

## Public API

One exported function:

```typescript
export function preprocess(raw: Transition[]): PreprocessResult
```

It runs the four stages in sequence and returns the combined result.

## Internal functions — detailed specification

### `splitSentinels(transitions: Transition[]): { transitions: Transition[]; sentinelCount: number }`

Scans for consecutive pairs where `transition[i].to === OFF_BROWSER` and `transition[i+1].from === OFF_BROWSER`.

For each pair `(A → off_browser at ts₁)` + `(off_browser → B at ts₂)`:

1. Compute `offBrowserMs = ts₂ - ts₁`
2. If `offBrowserMs < SENTINEL_PASSTHROUGH_MS`:
   - Remove both transitions
   - If `A !== B`, inject a direct `{ from: A, to: B, ts: ts₂, dwellMs: transitions[i].dwellMs }` transition
   - If `A === B`, drop entirely (self-loop)
3. If `offBrowserMs < SENTINEL_BREAK_MS`:
   - Replace `off_browser` with `off_browser:<n>` (where `n` is a counter starting at 0)
   - Rewrite both transitions: `A → off_browser:<n>` and `off_browser:<n> → B`
   - Increment sentinelCount
4. If `offBrowserMs >= SENTINEL_BREAK_MS`:
   - Remove both transitions entirely (break boundary)

**Edge case:** If the transition list ends with `A → off_browser` without a matching return, remove that trailing transition (the user is still off-browser at flush time).

**Edge case:** If the transition list starts with `off_browser → B` without a preceding departure, remove that leading transition.

**Implementation approach:** Build a new array by iterating through the input. Use an index `i` that advances by 2 when a pair is found, or by 1 otherwise.

### `removeTransients(transitions: Transition[]): { transitions: Transition[]; excludedSources: Set<string> }`

Two passes:

**Pass 1 — Dwell-based detection:**
- Build a `Map<source, dwellMs[]>` of all outgoing dwell times per source
- A source is transient if ALL its outgoing dwellMs values are < `TRANSIENT_DWELL_MS`

**Pass 2 — Chain scanning:**
- Iterate through transitions with index `i` from 1 to `length - 2`
- If `transitions[i-1].dwellMs < TRANSIENT_CHAIN_MS` AND `transitions[i].dwellMs < TRANSIENT_CHAIN_MS` AND `transitions[i+1].dwellMs < TRANSIENT_CHAIN_MS`:
  - Mark `transitions[i].from` as transient

**Filter:** Remove all transitions where `from ∈ transient` OR `to ∈ transient`.

**Return:** The filtered transitions and the set of excluded sources (needed for bundle assignment — excluded bundles become singletons).

### `detectHubs(transitions: Transition[]): Set<string>`

1. Collect all unique sources from transition `from` and `to` fields
2. If `uniqueSources.size < HUB_MIN_SOURCES`, return empty set (hub detection disabled)
3. For each source, compute its unique neighbor set (union of all sources it has transitions to or from)
4. A source is a hub if `neighbors.size > uniqueSources.size * HUB_THRESHOLD_PERCENT`
5. Return the set of hub source IDs

### `chunkHubs(transitions: Transition[], hubSources: Set<string>): { transitions: Transition[]; chunkMap: Map<string, ChunkInfo> }`

For each hub source:

1. Collect all transitions involving this hub (where `from === hub` or `to === hub`)
2. Compute `baseTs = min(t.ts for t in hubTransitions)`
3. Compute `chunkWindowMs = computeChunkWindow(hubTransitions)`
4. For each transition involving the hub:
   - `chunkIndex = Math.floor((transition.ts - baseTs) / chunkWindowMs)`
   - `chunkId = "hub:" + hubSource + ":" + chunkIndex`
   - Replace the hub source ID with `chunkId` in the transition's `from` or `to` field
   - Add entry to `chunkMap`: `chunkId → { originalSource: hubSource, chunkIndex, windowStartMs: baseTs + chunkIndex * chunkWindowMs, chunkWindowMs }`

**Important:** Transitions are modified in-place (or a new array is built). Both `from` and `to` fields may need replacement if the transition is between two hubs (rare but possible).

### `computeChunkWindow(hubTransitions: Transition[]): number`

```typescript
function computeChunkWindow(hubTransitions: Transition[]): number {
    if (hubTransitions.length <= 1) return MAX_CHUNK_MS;
    const timestamps = hubTransitions.map(t => t.ts);
    const sessionMs = Math.max(...timestamps) - Math.min(...timestamps);
    if (sessionMs === 0) return MIN_CHUNK_MS;
    const idealChunks = Math.max(1, Math.floor(hubTransitions.length / TARGET_PER_CHUNK));
    const rawWindowMs = sessionMs / idealChunks;
    return Math.max(MIN_CHUNK_MS, Math.min(MAX_CHUNK_MS, rawWindowMs));
}
```

### `preprocess()` — the pipeline

```typescript
export function preprocess(raw: Transition[]): PreprocessResult {
    const step1 = splitSentinels([...raw]);  // don't mutate input
    const step2 = removeTransients(step1.transitions);
    const hubSources = detectHubs(step2.transitions);
    const step4 = chunkHubs(step2.transitions, hubSources);

    return {
        transitions: step4.transitions,
        excludedSources: step2.excludedSources,
        sentinelCount: step1.sentinelCount,
        chunkMap: step4.chunkMap,
        hubSources,
    };
}
```

## Test cases to verify mentally

### Sentinel splitting

Input:
```
A → off_browser (ts: 100)
off_browser → B (ts: 101)     // 1ms gap → pass-through
```
Output: `A → B` direct edge

Input:
```
A → off_browser (ts: 100)
off_browser → B (ts: 5100)    // 5s gap → keep as off_browser:0
```
Output: `A → off_browser:0`, `off_browser:0 → B`

Input:
```
A → off_browser (ts: 100)
off_browser → B (ts: 700100)  // 700s gap → break boundary
```
Output: both removed

### Transient removal

Input: source X has 3 outgoing transitions, all with dwellMs < 500ms
Output: X is transient, all transitions involving X are removed

### Hub chunking

Input: hub H has 20 transitions over 10 minutes
- `idealChunks = floor(20/4) = 5`
- `rawWindowMs = 600000/5 = 120000ms = 2 min`
- `chunkWindowMs = clamp(120000, 60000, 900000) = 120000`
Output: transitions rewritten with `hub:H:0`, `hub:H:1`, etc.

### Empty input

Input: `[]`
Output: `{ transitions: [], excludedSources: Set(), sentinelCount: 0, chunkMap: Map(), hubSources: Set() }`

## Verification

```bash
npx tsc --noEmit   # zero errors
npx vite build     # clean build
```

The file should compile cleanly. It has no side effects — it's a pure function that transforms data.

## Documentation update

After completing this step, update `.architecture/packer.md`:

In the **File map** table, change the `preprocess.ts` row to:
```
| `src/aggregation/preprocess.ts` | `preprocess()` — **Implemented.** Off-browser sentinel splitting, transient removal, hub detection, dynamic temporal chunking. |
```
