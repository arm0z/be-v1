# Packer Implementation Plan — Overview

This directory contains 8 sequential implementation steps for the Packer system. Each step is self-contained: it lists exactly which files to create/modify, what the code should look like, how to verify correctness, and ends with a documentation update to `.architecture/packer.md`.

## Step execution order

Steps MUST be executed in order. Each step depends on the previous step being complete and verified.

```text
1-types.md              Add new types to types.ts (Transition, DirectedGraph, etc.)
                        ↓
2-bundler.md            Rewrite bundler.ts — replace graph.recordEdge with transition log
                        ↓
3-aggregator.md         Rewrite index.ts — remove createGraph, wire transition log, update emitState
                        ↓
4-devhub.md             Update DevHub (dev.ts, GraphView, StateInspector) for transition-based data
                        ↓
5-preprocess.md         Create preprocess.ts — sentinel splitting, transient removal, hub chunking
                        ↓
6-directed-louvain.md   Create directed-louvain.ts — buildDirectedGraph + directedLouvain
                        ↓
7-packer.md             Create packer.ts — flush, partition, assign, assemble
                        ↓
8-integration.md        Wire packer into main.ts, delete graph.ts, final cleanup
```

## Verification at each step

Every step ends with:
1. `npx tsc --noEmit` — zero type errors
2. `npx vite build` — clean production build
3. Step-specific verification (described in each file)

## Reference document

The authoritative specification is `.architecture/packer.md`. Each step references specific sections of that document. At the end of each step, `packer.md` is updated to reflect what was implemented and where.

## Current codebase state (before step 1)

| File                                | Current state                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `src/aggregation/types.ts`          | Has `Bundle`, `Edge`, `Aggregator` (with `getEdges`/`drainEdges`)             |
| `src/aggregation/bundler.ts`        | Takes `graph` param, calls `graph.recordEdge()` on transitions                |
| `src/aggregation/index.ts`          | Creates `createGraph()`, passes to bundler, exposes `getEdges`/`drainEdges`   |
| `src/aggregation/graph.ts`          | `createGraph()` — pre-aggregates transitions into `Edge { from, to, weight }` |
| `src/aggregation/translate.ts`      | `translate(bundle)` — unchanged by this plan                                  |
| `src/event/dev.ts`                  | `DevStateSnapshot` includes `edges` array and `urls` record                   |
| `src/dev/panels/GraphView.tsx`      | Consumes graph data via dev events (`edge.created`, `edge.incremented`)       |
| `src/dev/panels/StateInspector.tsx` | Reads `snapshot.edges` from dev state snapshots                               |
| `src/background/main.ts`            | Creates aggregator, registers Chrome listeners                                |
