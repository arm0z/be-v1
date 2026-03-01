import type { ChunkInfo, PreprocessResult, Transition } from "./types.ts";

import { OFF_BROWSER } from "./types.ts";

// ── Constants (defaults) ────────────────────────────────────

const SENTINEL_PASSTHROUGH_MS = 2_000;
const SENTINEL_BREAK_MS = 600_000;
const TRANSIENT_DWELL_MS = 500;
const TRANSIENT_CHAIN_MS = 1_000;
const HUB_THRESHOLD_PERCENT = 0.1;
const HUB_MIN_SOURCES = 15;
const TARGET_PER_CHUNK = 4;
const MIN_CHUNK_MS = 60_000;
const MAX_CHUNK_MS = 900_000;

// ── Options ─────────────────────────────────────────────────

export type PreprocessOptions = {
    sentinelPassthroughMs?: number;
    sentinelBreakMs?: number;
    transientDwellMs?: number;
    transientChainMs?: number;
    hubThresholdPercent?: number;
    hubMinSources?: number;
    targetPerChunk?: number;
    minChunkMs?: number;
    maxChunkMs?: number;
};

type ResolvedOptions = {
    sentinelPassthroughMs: number;
    sentinelBreakMs: number;
    transientDwellMs: number;
    transientChainMs: number;
    hubThresholdPercent: number;
    hubMinSources: number;
    targetPerChunk: number;
    minChunkMs: number;
    maxChunkMs: number;
};

function resolveOptions(opts?: PreprocessOptions): ResolvedOptions {
    return {
        sentinelPassthroughMs:
            opts?.sentinelPassthroughMs ?? SENTINEL_PASSTHROUGH_MS,
        sentinelBreakMs: opts?.sentinelBreakMs ?? SENTINEL_BREAK_MS,
        transientDwellMs: opts?.transientDwellMs ?? TRANSIENT_DWELL_MS,
        transientChainMs: opts?.transientChainMs ?? TRANSIENT_CHAIN_MS,
        hubThresholdPercent: opts?.hubThresholdPercent ?? HUB_THRESHOLD_PERCENT,
        hubMinSources: opts?.hubMinSources ?? HUB_MIN_SOURCES,
        targetPerChunk: opts?.targetPerChunk ?? TARGET_PER_CHUNK,
        minChunkMs: opts?.minChunkMs ?? MIN_CHUNK_MS,
        maxChunkMs: opts?.maxChunkMs ?? MAX_CHUNK_MS,
    };
}

// ── Stage 1: Off-browser sentinel splitting ────────────────

function splitSentinels(
    transitions: Transition[],
    opts: ResolvedOptions,
): {
    transitions: Transition[];
    sentinelCount: number;
} {
    const result: Transition[] = [];
    let sentinelCount = 0;
    let i = 0;

    while (i < transitions.length) {
        const current = transitions[i];

        // Look for A → off_browser paired with off_browser → B
        if (
            current.to === OFF_BROWSER &&
            i + 1 < transitions.length &&
            transitions[i + 1].from === OFF_BROWSER
        ) {
            const next = transitions[i + 1];
            const offBrowserMs = next.ts - current.ts;

            if (offBrowserMs < opts.sentinelPassthroughMs) {
                // Pass-through: inject direct A → B (unless self-loop)
                if (current.from !== next.to) {
                    result.push({
                        from: current.from,
                        to: next.to,
                        ts: next.ts,
                        dwellMs: current.dwellMs,
                    });
                }
            } else if (offBrowserMs < opts.sentinelBreakMs) {
                // Keep as ephemeral node
                const sentinelId = `${OFF_BROWSER}:${sentinelCount}`;
                result.push({
                    from: current.from,
                    to: sentinelId,
                    ts: current.ts,
                    dwellMs: current.dwellMs,
                });
                result.push({
                    from: sentinelId,
                    to: next.to,
                    ts: next.ts,
                    dwellMs: next.dwellMs,
                });
                sentinelCount++;
            }
            // else: break boundary — both transitions dropped

            i += 2;
            continue;
        }

        // Trailing A → off_browser without return: drop it
        if (current.to === OFF_BROWSER) {
            i++;
            continue;
        }

        // Leading off_browser → B without preceding departure: drop it
        if (current.from === OFF_BROWSER) {
            i++;
            continue;
        }

        result.push(current);
        i++;
    }

    return { transitions: result, sentinelCount };
}

// ── Stage 2: Transient source removal ──────────────────────

function removeTransients(
    transitions: Transition[],
    opts: ResolvedOptions,
): {
    transitions: Transition[];
    excludedSources: Set<string>;
} {
    const transient = new Set<string>();

    // Pass 1: dwell-based detection
    const outgoingDwells = new Map<string, number[]>();
    for (const t of transitions) {
        let dwells = outgoingDwells.get(t.from);
        if (!dwells) {
            dwells = [];
            outgoingDwells.set(t.from, dwells);
        }
        dwells.push(t.dwellMs);
    }
    for (const [source, dwells] of outgoingDwells) {
        if (dwells.every((d) => d < opts.transientDwellMs)) {
            transient.add(source);
        }
    }

    // Pass 2: chain scanning
    for (let i = 1; i < transitions.length - 1; i++) {
        if (
            transitions[i - 1].dwellMs < opts.transientChainMs &&
            transitions[i].dwellMs < opts.transientChainMs &&
            transitions[i + 1].dwellMs < opts.transientChainMs
        ) {
            transient.add(transitions[i].from);
        }
    }

    // Filter
    const filtered = transitions.filter(
        (t) => !transient.has(t.from) && !transient.has(t.to),
    );

    return { transitions: filtered, excludedSources: transient };
}

// ── Stage 3: Hub detection ─────────────────────────────────

function detectHubs(
    transitions: Transition[],
    opts: ResolvedOptions,
): Set<string> {
    const allSources = new Set<string>();
    for (const t of transitions) {
        allSources.add(t.from);
        allSources.add(t.to);
    }

    if (allSources.size < opts.hubMinSources) return new Set();

    const neighbors = new Map<string, Set<string>>();
    for (const t of transitions) {
        let fromNeighbors = neighbors.get(t.from);
        if (!fromNeighbors) {
            fromNeighbors = new Set();
            neighbors.set(t.from, fromNeighbors);
        }
        fromNeighbors.add(t.to);

        let toNeighbors = neighbors.get(t.to);
        if (!toNeighbors) {
            toNeighbors = new Set();
            neighbors.set(t.to, toNeighbors);
        }
        toNeighbors.add(t.from);
    }

    const threshold = allSources.size * opts.hubThresholdPercent;
    const hubs = new Set<string>();
    for (const [source, sourceNeighbors] of neighbors) {
        if (sourceNeighbors.size > threshold) {
            hubs.add(source);
        }
    }

    return hubs;
}

// ── Stage 4: Hub temporal chunking ─────────────────────────

function computeChunkWindow(
    hubTransitions: Transition[],
    opts: ResolvedOptions,
): number {
    if (hubTransitions.length <= 1) return opts.maxChunkMs;
    const timestamps = hubTransitions.map((t) => t.ts);
    const sessionMs = Math.max(...timestamps) - Math.min(...timestamps);
    if (sessionMs === 0) return opts.minChunkMs;
    const idealChunks = Math.max(
        1,
        Math.floor(hubTransitions.length / opts.targetPerChunk),
    );
    const rawWindowMs = sessionMs / idealChunks;
    return Math.max(opts.minChunkMs, Math.min(opts.maxChunkMs, rawWindowMs));
}

function chunkHubs(
    transitions: Transition[],
    hubSources: Set<string>,
    opts: ResolvedOptions,
): { transitions: Transition[]; chunkMap: Map<string, ChunkInfo> } {
    if (hubSources.size === 0) {
        return { transitions, chunkMap: new Map() };
    }

    // Collect transitions per hub for window computation
    const hubTransitions = new Map<string, Transition[]>();
    for (const hub of hubSources) {
        hubTransitions.set(hub, []);
    }
    for (const t of transitions) {
        if (hubSources.has(t.from)) hubTransitions.get(t.from)!.push(t);
        if (hubSources.has(t.to)) hubTransitions.get(t.to)!.push(t);
    }

    // Compute base timestamp and chunk window per hub
    const hubMeta = new Map<
        string,
        { baseTs: number; chunkWindowMs: number }
    >();
    for (const [hub, hTransitions] of hubTransitions) {
        const baseTs = Math.min(...hTransitions.map((t) => t.ts));
        const chunkWindowMs = computeChunkWindow(hTransitions, opts);
        hubMeta.set(hub, { baseTs, chunkWindowMs });
    }

    const chunkMap = new Map<string, ChunkInfo>();

    function rewriteSource(source: string, timestamp: number): string {
        if (!hubSources.has(source)) return source;
        const meta = hubMeta.get(source)!;
        const chunkIndex = Math.floor(
            (timestamp - meta.baseTs) / meta.chunkWindowMs,
        );
        const chunkId = `hub:${source}:${chunkIndex}`;
        if (!chunkMap.has(chunkId)) {
            chunkMap.set(chunkId, {
                originalSource: source,
                chunkIndex,
                windowStartMs: meta.baseTs + chunkIndex * meta.chunkWindowMs,
                chunkWindowMs: meta.chunkWindowMs,
            });
        }
        return chunkId;
    }

    const result = transitions.map((t) => ({
        from: rewriteSource(t.from, t.ts),
        to: rewriteSource(t.to, t.ts),
        ts: t.ts,
        dwellMs: t.dwellMs,
    }));

    return { transitions: result, chunkMap };
}

// ── Pipeline ───────────────────────────────────────────────

export function preprocess(
    raw: Transition[],
    options?: PreprocessOptions,
): PreprocessResult {
    const opts = resolveOptions(options);
    const step1 = splitSentinels([...raw], opts);
    const step2 = removeTransients(step1.transitions, opts);
    const hubSources = detectHubs(step2.transitions, opts);
    const step4 = chunkHubs(step2.transitions, hubSources, opts);

    return {
        transitions: step4.transitions,
        excludedSources: step2.excludedSources,
        sentinelCount: step1.sentinelCount,
        chunkMap: step4.chunkMap,
        hubSources,
    };
}
