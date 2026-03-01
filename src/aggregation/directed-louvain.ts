import type { DirectedGraph, LouvainResult, Transition } from "./types.ts";

const DEFAULT_RESOLUTION = 1.0;
const MIN_IMPROVEMENT = 1e-6;
const MAX_PASSES = 10;
const MAX_LOCAL_ITERATIONS = 100;

// ── Graph construction ──────────────────────────────────────

export function buildDirectedGraph(transitions: Transition[]): DirectedGraph {
    const nodes = new Set<string>();
    const edges = new Map<string, number>();
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    let totalWeight = 0;

    for (const t of transitions) {
        nodes.add(t.from);
        nodes.add(t.to);

        const key = t.from + "\0" + t.to;
        edges.set(key, (edges.get(key) ?? 0) + 1);
        outDegree.set(t.from, (outDegree.get(t.from) ?? 0) + 1);
        inDegree.set(t.to, (inDegree.get(t.to) ?? 0) + 1);
        totalWeight++;
    }

    // Ensure every node has entries in both degree maps
    for (const node of nodes) {
        if (!inDegree.has(node)) inDegree.set(node, 0);
        if (!outDegree.has(node)) outDegree.set(node, 0);
    }

    return { nodes, edges, inDegree, outDegree, totalWeight };
}

// ── Internal types ──────────────────────────────────────────

type CommunityState = {
    sigmaIn: number;
    sigmaOut: number;
    internalWeight: number;
};

type NodeState = {
    community: string;
    kIn: number;
    kOut: number;
    selfLoop: number;
};

// ── Directed Louvain ────────────────────────────────────────

export function directedLouvain(
    graph: DirectedGraph,
    resolution?: number,
): LouvainResult {
    // Edge cases
    if (graph.nodes.size === 0) {
        return { communities: new Map(), modularity: 0 };
    }
    if (graph.nodes.size === 1) {
        const node = graph.nodes.values().next().value as string;
        return { communities: new Map([[node, node]]), modularity: 0 };
    }
    if (graph.totalWeight === 0) {
        const communities = new Map<string, string>();
        for (const node of graph.nodes) communities.set(node, node);
        return { communities, modularity: 0 };
    }

    const gamma = resolution ?? DEFAULT_RESOLUTION;

    // Build adjacency lists for fast neighbor iteration
    let outEdges = new Map<string, Map<string, number>>();
    let inEdges = new Map<string, Map<string, number>>();
    for (const node of graph.nodes) {
        outEdges.set(node, new Map());
        inEdges.set(node, new Map());
    }
    for (const [key, weight] of graph.edges) {
        const sep = key.indexOf("\0");
        const from = key.slice(0, sep);
        const to = key.slice(sep + 1);
        outEdges.get(from)!.set(to, weight);
        inEdges.get(to)!.set(from, weight);
    }

    // Track original node → community across passes
    let nodeToOriginal = new Map<string, string[]>();
    for (const node of graph.nodes) {
        nodeToOriginal.set(node, [node]);
    }

    let currentNodes = new Set(graph.nodes);
    let currentOutEdges = outEdges;
    let currentInEdges = inEdges;
    let currentInDegree = new Map(graph.inDegree);
    let currentOutDegree = new Map(graph.outDegree);
    let currentTotalWeight = graph.totalWeight;
    let currentEdges = new Map(graph.edges);

    let previousModularity = -Infinity;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        // ── Phase 1: Local greedy moves ─────────────────────

        const nodeState = new Map<string, NodeState>();
        const communityState = new Map<string, CommunityState>();

        for (const node of currentNodes) {
            const kIn = currentInDegree.get(node) ?? 0;
            const kOut = currentOutDegree.get(node) ?? 0;
            const selfLoop = currentEdges.get(node + "\0" + node) ?? 0;

            nodeState.set(node, {
                community: node,
                kIn,
                kOut,
                selfLoop,
            });
            communityState.set(node, {
                sigmaIn: kIn,
                sigmaOut: kOut,
                internalWeight: selfLoop,
            });
        }

        const nodeList = [...currentNodes];

        for (let iter = 0; iter < MAX_LOCAL_ITERATIONS; iter++) {
            // Fisher-Yates shuffle to avoid order-dependent bias
            for (let j = nodeList.length - 1; j > 0; j--) {
                const k = Math.floor(Math.random() * (j + 1));
                [nodeList[j], nodeList[k]] = [nodeList[k], nodeList[j]];
            }
            let improved = false;

            for (const node of nodeList) {
                const ns = nodeState.get(node)!;
                const currentCommunity = ns.community;

                // Find neighbor communities
                const neighborCommunities = new Set<string>();
                const nodeOut = currentOutEdges.get(node);
                const nodeIn = currentInEdges.get(node);
                if (nodeOut) {
                    for (const target of nodeOut.keys()) {
                        neighborCommunities.add(
                            nodeState.get(target)!.community,
                        );
                    }
                }
                if (nodeIn) {
                    for (const source of nodeIn.keys()) {
                        neighborCommunities.add(
                            nodeState.get(source)!.community,
                        );
                    }
                }

                let bestDeltaQ = 0;
                let bestCommunity = currentCommunity;

                for (const candidate of neighborCommunities) {
                    if (candidate === currentCommunity) continue;

                    const deltaQ = computeDeltaQ(
                        node,
                        currentCommunity,
                        candidate,
                        nodeState,
                        communityState,
                        currentOutEdges,
                        currentInEdges,
                        currentTotalWeight,
                        gamma,
                    );

                    if (deltaQ > bestDeltaQ) {
                        bestDeltaQ = deltaQ;
                        bestCommunity = candidate;
                    }
                }

                if (bestCommunity !== currentCommunity) {
                    // Remove node from current community
                    removeNodeFromCommunity(
                        node,
                        currentCommunity,
                        ns,
                        communityState,
                        currentOutEdges,
                        currentInEdges,
                        nodeState,
                    );
                    // Add node to best community
                    addNodeToCommunity(
                        node,
                        bestCommunity,
                        ns,
                        communityState,
                        currentOutEdges,
                        currentInEdges,
                        nodeState,
                    );
                    ns.community = bestCommunity;
                    improved = true;
                }
            }

            if (!improved) break;
        }

        // Compute modularity after phase 1
        const modularity = computeModularity(
            currentEdges,
            nodeState,
            currentTotalWeight,
            gamma,
            currentInDegree,
            currentOutDegree,
        );

        if (modularity - previousModularity < MIN_IMPROVEMENT) break;
        previousModularity = modularity;

        // ── Phase 2: Coarsen ────────────────────────────────

        // Map communities to super-node IDs
        const communityIds = new Map<string, string>();
        let nextId = 0;
        for (const ns of nodeState.values()) {
            if (!communityIds.has(ns.community)) {
                communityIds.set(ns.community, String(nextId++));
            }
        }

        // Check if any merging happened
        if (communityIds.size === currentNodes.size) break;

        // Update original-node mapping
        const newNodeToOriginal = new Map<string, string[]>();
        for (const [node, ns] of nodeState) {
            const superId = communityIds.get(ns.community)!;
            const originals = nodeToOriginal.get(node)!;
            const existing = newNodeToOriginal.get(superId);
            if (existing) {
                existing.push(...originals);
            } else {
                newNodeToOriginal.set(superId, [...originals]);
            }
        }
        nodeToOriginal = newNodeToOriginal;

        // Build coarsened graph
        const newEdges = new Map<string, number>();
        const newInDegree = new Map<string, number>();
        const newOutDegree = new Map<string, number>();
        const newNodes = new Set<string>();
        let newTotalWeight = 0;

        for (const id of communityIds.values()) {
            newNodes.add(id);
            newInDegree.set(id, 0);
            newOutDegree.set(id, 0);
        }

        for (const [key, weight] of currentEdges) {
            const sep = key.indexOf("\0");
            const fromNode = key.slice(0, sep);
            const toNode = key.slice(sep + 1);
            const fromSuper = communityIds.get(
                nodeState.get(fromNode)!.community,
            )!;
            const toSuper = communityIds.get(nodeState.get(toNode)!.community)!;

            const newKey = fromSuper + "\0" + toSuper;
            newEdges.set(newKey, (newEdges.get(newKey) ?? 0) + weight);
            newOutDegree.set(fromSuper, newOutDegree.get(fromSuper)! + weight);
            newInDegree.set(toSuper, newInDegree.get(toSuper)! + weight);
            newTotalWeight += weight;
        }

        // Build new adjacency lists
        const newOutEdgesMap = new Map<string, Map<string, number>>();
        const newInEdgesMap = new Map<string, Map<string, number>>();
        for (const id of newNodes) {
            newOutEdgesMap.set(id, new Map());
            newInEdgesMap.set(id, new Map());
        }
        for (const [key, weight] of newEdges) {
            const sep = key.indexOf("\0");
            const from = key.slice(0, sep);
            const to = key.slice(sep + 1);
            newOutEdgesMap.get(from)!.set(to, weight);
            newInEdgesMap.get(to)!.set(from, weight);
        }

        currentNodes = newNodes;
        currentEdges = newEdges;
        currentOutEdges = newOutEdgesMap;
        currentInEdges = newInEdgesMap;
        currentInDegree = newInDegree;
        currentOutDegree = newOutDegree;
        currentTotalWeight = newTotalWeight;
    }

    // Build final community mapping from original nodes
    const communities = new Map<string, string>();
    for (const [superNode, originals] of nodeToOriginal) {
        for (const original of originals) {
            communities.set(original, superNode);
        }
    }

    // Compute final modularity on original graph
    const finalNodeState = new Map<string, NodeState>();
    for (const node of graph.nodes) {
        finalNodeState.set(node, {
            community: communities.get(node)!,
            kIn: graph.inDegree.get(node) ?? 0,
            kOut: graph.outDegree.get(node) ?? 0,
            selfLoop: graph.edges.get(node + "\0" + node) ?? 0,
        });
    }
    const finalModularity = computeModularity(
        graph.edges,
        finalNodeState,
        graph.totalWeight,
        gamma,
        graph.inDegree,
        graph.outDegree,
    );

    return { communities, modularity: finalModularity };
}

// ── Helpers ─────────────────────────────────────────────────

function computeDeltaQ(
    node: string,
    cOld: string,
    cNew: string,
    nodeState: Map<string, NodeState>,
    communityState: Map<string, CommunityState>,
    outEdgesMap: Map<string, Map<string, number>>,
    inEdgesMap: Map<string, Map<string, number>>,
    totalWeight: number,
    gamma: number,
): number {
    const ns = nodeState.get(node)!;
    const m = totalWeight;

    // Compute weights between node and target community
    let wNodeToNew = 0;
    let wNewToNode = 0;
    const nodeOut = outEdgesMap.get(node);
    if (nodeOut) {
        for (const [target, weight] of nodeOut) {
            if (nodeState.get(target)!.community === cNew) {
                wNodeToNew += weight;
            }
        }
    }
    const nodeIn = inEdgesMap.get(node);
    if (nodeIn) {
        for (const [source, weight] of nodeIn) {
            if (nodeState.get(source)!.community === cNew) {
                wNewToNode += weight;
            }
        }
    }

    // Compute weights between node and old community (excluding self-loop)
    let wNodeToOld = 0;
    let wOldToNode = 0;
    if (nodeOut) {
        for (const [target, weight] of nodeOut) {
            if (target !== node && nodeState.get(target)!.community === cOld) {
                wNodeToOld += weight;
            }
        }
    }
    if (nodeIn) {
        for (const [source, weight] of nodeIn) {
            if (source !== node && nodeState.get(source)!.community === cOld) {
                wOldToNode += weight;
            }
        }
    }

    const csNew = communityState.get(cNew)!;
    const csOld = communityState.get(cOld)!;

    // ΔQ_insert
    const deltaInsert =
        (wNodeToNew + wNewToNode) / m -
        (gamma * (ns.kOut * csNew.sigmaIn + ns.kIn * csNew.sigmaOut)) / (m * m);

    // ΔQ_remove
    const deltaRemove =
        (wNodeToOld + wOldToNode) / m -
        (gamma *
            (ns.kOut * (csOld.sigmaIn - ns.kIn) +
                ns.kIn * (csOld.sigmaOut - ns.kOut))) /
            (m * m);

    return deltaInsert - deltaRemove;
}

function removeNodeFromCommunity(
    node: string,
    community: string,
    ns: NodeState,
    communityState: Map<string, CommunityState>,
    outEdgesMap: Map<string, Map<string, number>>,
    inEdgesMap: Map<string, Map<string, number>>,
    nodeState: Map<string, NodeState>,
): void {
    const cs = communityState.get(community)!;
    cs.sigmaIn -= ns.kIn;
    cs.sigmaOut -= ns.kOut;

    // Subtract internal weight: edges from node to community members + community members to node
    let internalLoss = ns.selfLoop;
    const nodeOut = outEdgesMap.get(node);
    if (nodeOut) {
        for (const [target, weight] of nodeOut) {
            if (
                target !== node &&
                nodeState.get(target)!.community === community
            ) {
                internalLoss += weight;
            }
        }
    }
    const nodeIn = inEdgesMap.get(node);
    if (nodeIn) {
        for (const [source, weight] of nodeIn) {
            if (
                source !== node &&
                nodeState.get(source)!.community === community
            ) {
                internalLoss += weight;
            }
        }
    }
    cs.internalWeight -= internalLoss;
}

function addNodeToCommunity(
    node: string,
    community: string,
    ns: NodeState,
    communityState: Map<string, CommunityState>,
    outEdgesMap: Map<string, Map<string, number>>,
    inEdgesMap: Map<string, Map<string, number>>,
    nodeState: Map<string, NodeState>,
): void {
    const cs = communityState.get(community)!;
    cs.sigmaIn += ns.kIn;
    cs.sigmaOut += ns.kOut;

    // Add internal weight: edges from node to community members + community members to node
    let internalGain = ns.selfLoop;
    const nodeOut = outEdgesMap.get(node);
    if (nodeOut) {
        for (const [target, weight] of nodeOut) {
            if (
                target !== node &&
                nodeState.get(target)!.community === community
            ) {
                internalGain += weight;
            }
        }
    }
    const nodeIn = inEdgesMap.get(node);
    if (nodeIn) {
        for (const [source, weight] of nodeIn) {
            if (
                source !== node &&
                nodeState.get(source)!.community === community
            ) {
                internalGain += weight;
            }
        }
    }
    cs.internalWeight += internalGain;
}

function computeModularity(
    edges: Map<string, number>,
    nodeState: Map<string, NodeState>,
    totalWeight: number,
    gamma: number,
    inDegree: Map<string, number>,
    outDegree: Map<string, number>,
): number {
    if (totalWeight === 0) return 0;
    const m = totalWeight;
    let q = 0;

    for (const [key, weight] of edges) {
        const sep = key.indexOf("\0");
        const from = key.slice(0, sep);
        const to = key.slice(sep + 1);

        const nsFrom = nodeState.get(from);
        const nsTo = nodeState.get(to);
        if (!nsFrom || !nsTo) continue;

        if (nsFrom.community === nsTo.community) {
            const kOutI = outDegree.get(from) ?? 0;
            const kInJ = inDegree.get(to) ?? 0;
            q += weight - (gamma * (kOutI * kInJ)) / m;
        }
    }

    return q / m;
}
