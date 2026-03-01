import type {
    Aggregator,
    Bundle,
    DirectedGraph,
    Edge,
    Group,
    GroupMeta,
    LouvainResult,
    Packet,
    PreprocessResult,
    Transition,
} from "./types.ts";
import { buildDirectedGraph, directedLouvain } from "./directed-louvain.ts";

import { dev } from "../event/dev.ts";
import { preprocess } from "./preprocess.ts";

export function createPacker(aggregator: Aggregator): {
    flush(): Packet | null;
    peek(): Packet | null;
} {
    function pack(destructive: boolean): Packet | null {
        // 1. Seal any in-flight bundle so no data is lost
        aggregator.seal();

        // 2. Read accumulated data (destructive or non-destructive)
        const bundles = destructive
            ? aggregator.drainSealed()
            : aggregator.getSealed();
        const transitions = destructive
            ? aggregator.drainTransitions()
            : aggregator.getTransitions();

        // 3. Nothing to pack
        if (bundles.length === 0) return null;

        // 4. Partition bundles into groups
        const { groups, edges } = partitionIntoGroups(transitions, bundles);

        // 5. Assemble the Packet
        const packet: Packet = {
            id: crypto.randomUUID(),
            groups,
            edges,
            createdAt: Date.now(),
        };

        const kind = destructive ? "pack.flushed" : "pack.peeked";
        dev.log("packer", kind, `packet ${packet.id}`, {
            groups: groups.length,
            bundles: bundles.length,
            edges: edges.length,
            packetId: packet.id,
        });

        return packet;
    }

    function flush(): Packet | null {
        return pack(true);
    }

    function peek(): Packet | null {
        return pack(false);
    }

    return { flush, peek };
}

// ── Internal helpers ────────────────────────────────────────

function partitionIntoGroups(
    transitions: Transition[],
    bundles: Bundle[],
): { groups: Group[]; edges: Edge[] } {
    // If no transitions, every bundle is a singleton group
    if (transitions.length === 0) {
        const groups = bundles.map((b) => makeGroup(crypto.randomUUID(), [b]));
        return { groups, edges: [] };
    }

    // 1. Preprocess transitions
    const preprocessResult = preprocess(transitions);

    dev.log(
        "packer",
        "pack.preprocessed",
        `${transitions.length} → ${preprocessResult.transitions.length} transitions`,
        {
            raw: transitions.length,
            filtered: preprocessResult.transitions.length,
            sentinels: preprocessResult.sentinelCount,
            excluded: [...preprocessResult.excludedSources],
            hubs: [...preprocessResult.hubSources],
            chunks: preprocessResult.chunkMap.size,
        },
    );

    // 2. Build directed graph from preprocessed transitions
    const graph = buildDirectedGraph(preprocessResult.transitions);

    dev.log(
        "packer",
        "pack.graph",
        `${graph.nodes.size} nodes, ${graph.edges.size} edges`,
        {
            nodes: graph.nodes.size,
            edges: graph.edges.size,
            totalWeight: graph.totalWeight,
        },
    );

    // 3. Run Louvain community detection
    const louvain = directedLouvain(graph);

    dev.log(
        "packer",
        "pack.louvain",
        `${new Set(louvain.communities.values()).size} communities (Q=${louvain.modularity.toFixed(4)})`,
        {
            communities: new Set(louvain.communities.values()).size,
            modularity: louvain.modularity,
            nodes: louvain.communities.size,
        },
    );

    // 4. Assign bundles to communities
    const bundleGroups = assignBundles(louvain, bundles, preprocessResult);

    // 5. Build Group objects
    const groups: Group[] = [];
    for (const [groupKey, groupBundles] of bundleGroups) {
        groups.push(makeGroup(groupKey, groupBundles));
    }

    // 6. Extract edges for the Packet payload
    const edges = graphToEdges(graph);

    return { groups, edges };
}

function assignBundles(
    louvain: LouvainResult,
    bundles: Bundle[],
    pr: PreprocessResult,
): Map<string, Bundle[]> {
    const groups = new Map<string, Bundle[]>();

    // Pre-compute: for each hub source, find its baseTs and chunkWindowMs
    const hubMeta = new Map<
        string,
        { baseTs: number; chunkWindowMs: number }
    >();
    for (const [, info] of pr.chunkMap) {
        if (!hubMeta.has(info.originalSource)) {
            hubMeta.set(info.originalSource, {
                baseTs: info.windowStartMs,
                chunkWindowMs: info.chunkWindowMs,
            });
        } else {
            const existing = hubMeta.get(info.originalSource)!;
            if (info.windowStartMs < existing.baseTs) {
                existing.baseTs = info.windowStartMs;
            }
        }
    }

    for (const bundle of bundles) {
        let groupKey: string;

        if (pr.excludedSources.has(bundle.source)) {
            // Path 1: Transient source → singleton
            groupKey = `singleton:${bundle.source}`;
        } else if (pr.hubSources.has(bundle.source)) {
            // Path 2: Hub source → find chunk by startedAt
            const meta = hubMeta.get(bundle.source);
            if (meta) {
                const chunkIndex = Math.floor(
                    (bundle.startedAt - meta.baseTs) / meta.chunkWindowMs,
                );
                const chunkId = `hub:${bundle.source}:${chunkIndex}`;
                const community = louvain.communities.get(chunkId);
                groupKey = community ?? `singleton:${bundle.source}`;
            } else {
                groupKey = `singleton:${bundle.source}`;
            }
        } else if (louvain.communities.has(bundle.source)) {
            // Path 3: Normal source with a community
            groupKey = louvain.communities.get(bundle.source)!;
        } else {
            // Path 4: Isolated source (no transitions)
            groupKey = `singleton:${bundle.source}`;
        }

        let group = groups.get(groupKey);
        if (!group) {
            group = [];
            groups.set(groupKey, group);
        }
        group.push(bundle);
    }

    return groups;
}

function makeGroup(id: string, bundles: Bundle[]): Group {
    const sorted = [...bundles].sort((a, b) => a.startedAt - b.startedAt);

    return {
        id,
        bundles: sorted,
        text: sorted
            .map((b) => b.text ?? "")
            .filter((t) => t.length > 0)
            .join("\n"),
        meta: computeMeta(sorted),
    };
}

function computeMeta(bundles: Bundle[]): GroupMeta {
    const sources = [...new Set(bundles.map((b) => b.source))];
    const tabs = [
        ...new Set(
            bundles.map((b) => {
                const atIndex = b.source.lastIndexOf("@");
                return atIndex !== -1 ? b.source.slice(atIndex + 1) : b.source;
            }),
        ),
    ];

    const starts = bundles.map((b) => b.startedAt);
    const ends = bundles
        .map((b) => b.endedAt)
        .filter((e): e is number => e !== null);

    const idleMs = bundles.reduce((sum, b) => sum + b.idleMs, 0);

    return {
        sources,
        tabs,
        timeRange: {
            start: Math.min(...starts),
            end: ends.length > 0 ? Math.max(...ends) : Math.max(...starts),
        },
        idleMs,
    };
}

function graphToEdges(graph: DirectedGraph): Edge[] {
    const edges: Edge[] = [];
    for (const [key, weight] of graph.edges) {
        const sepIndex = key.indexOf("\0");
        const from = key.slice(0, sepIndex);
        const to = key.slice(sepIndex + 1);
        edges.push({ from, to, weight });
    }
    return edges;
}
