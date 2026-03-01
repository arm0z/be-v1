import type { DirectedGraph, LouvainResult, PreprocessResult, Transition } from "@/aggregation/types";
import { buildDirectedGraph, directedLouvain } from "@/aggregation/directed-louvain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DevEntry } from "@/event/dev";
import { preprocess } from "@/aggregation/preprocess";

import type { Edge, Node } from "./graph/types";
import { DEFAULT_PHYSICS } from "./graph/types";
import { useForceSimulation } from "./graph/useForceSimulation";
import { useCanvasInteraction } from "./graph/useCanvasInteraction";
import { useCanvasRenderer } from "./graph/useCanvasRenderer";
import { GraphToolbar } from "./graph/GraphToolbar";
import { GraphSidePanel } from "./graph/GraphSidePanel";
import { NodeTooltip, useTooltipStats } from "./graph/NodeTooltip";

type Props = { entries: DevEntry[]; onClear?: () => void };

export function GraphView({ entries, onClear }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasWrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);

    const nodesRef = useRef<Map<string, Node>>(new Map());
    const edgesRef = useRef<Map<string, Edge>>(new Map());
    const processedRef = useRef(0);
    const cachedNodesRef = useRef<Node[]>([]);
    const cachedEdgesRef = useRef<Edge[]>([]);

    const panRef = useRef({ x: 0, y: 0 });
    const zoomRef = useRef(1);
    const awakeRef = useRef(true);
    const dirtyRef = useRef(true);
    const rafRef = useRef(0);
    const hoverIdRef = useRef<string | null>(null);

    const dragRef = useRef<{
        type: "pan" | "node";
        nodeId?: string;
        startX: number;
        startY: number;
        startPanX: number;
        startPanY: number;
    } | null>(null);

    const [isFullscreen, setIsFullscreen] = useState(false);
    const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<"raw" | "grouped">("raw");
    const [panelOpen, setPanelOpen] = useState(false);
    const [panelWidth, setPanelWidth] = useState(288);
    const [dimMode, setDimMode] = useState(false);
    const dimRef = useRef(false);
    const [physicsOpen, setPhysicsOpen] = useState(false);

    const physicsRef = useRef({ ...DEFAULT_PHYSICS });
    const [physics, setPhysics] = useState({ ...physicsRef.current });

    // Tunable algorithm parameters
    const [resolution, setResolution] = useState(1.0);
    const [hubThreshold, setHubThreshold] = useState(0.1);
    const [hubMinSources, setHubMinSources] = useState(15);
    const [sentinelPassthroughMs, setSentinelPassthroughMs] = useState(2000);
    const [sentinelBreakMs, setSentinelBreakMs] = useState(600000);
    const [transientDwellMs, setTransientDwellMs] = useState(500);
    const [targetPerChunk, setTargetPerChunk] = useState(4);

    // Extract transitions from the latest snapshot
    const latestTransitions = useMemo(() => {
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry.event === "state.snapshot" && entry.data) {
                const snapshot = entry.data as { transitions?: Transition[] };
                return snapshot.transitions ?? [];
            }
        }
        return [];
    }, [entries]);

    // Compute grouped graph
    const groupedResultRef = useRef<{
        pr: PreprocessResult;
        graph: DirectedGraph;
        louvain: LouvainResult;
    } | null>(null);

    const groupedResult = useMemo(() => {
        if (activeTab !== "grouped" || latestTransitions.length === 0) {
            groupedResultRef.current = null;
            return null;
        }
        const pr = preprocess(latestTransitions, {
            sentinelPassthroughMs, sentinelBreakMs, transientDwellMs,
            hubThresholdPercent: hubThreshold, hubMinSources, targetPerChunk,
        });
        const graph = buildDirectedGraph(pr.transitions);
        const louvain = directedLouvain(graph, resolution);
        const result = { pr, graph, louvain };
        groupedResultRef.current = result;
        return result;
    }, [
        activeTab, latestTransitions, resolution, hubThreshold, hubMinSources,
        sentinelPassthroughMs, sentinelBreakMs, transientDwellMs, targetPerChunk,
    ]);

    const activeTabRef = useRef(activeTab);
    activeTabRef.current = activeTab;

    const communityBreakdown = useMemo(() => {
        if (!groupedResult) return null;
        const map = new Map<string, string[]>();
        for (const [nodeId, cId] of groupedResult.louvain.communities) {
            let m = map.get(cId);
            if (!m) { m = []; map.set(cId, m); }
            m.push(nodeId);
        }
        return { communities: map, uniqueIds: [...map.keys()] };
    }, [groupedResult]);

    // Data extraction (raw mode)
    const processEntries = useCallback(() => {
        if (entries.length < processedRef.current) {
            nodesRef.current.clear();
            edgesRef.current.clear();
            processedRef.current = 0;
        }
        if (activeTabRef.current === "grouped") {
            processedRef.current = entries.length;
            return;
        }
        type SnapshotData = {
            transitions: { from: string; to: string; ts: number; dwellMs: number }[];
        };
        let latestSnapshot: SnapshotData | null = null;
        for (let i = processedRef.current; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.event === "state.snapshot" && entry.data) {
                latestSnapshot = entry.data as SnapshotData;
            }
        }
        processedRef.current = entries.length;
        if (!latestSnapshot) return;

        const transitions = latestSnapshot.transitions ?? [];
        const newEdges = new Map<string, Edge>();
        const nodeIds = new Set<string>();
        for (const t of transitions) {
            nodeIds.add(t.from);
            nodeIds.add(t.to);
            const key = `${t.from}->${t.to}`;
            const existing = newEdges.get(key);
            if (existing) existing.weight++;
            else newEdges.set(key, { from: t.from, to: t.to, weight: 1 });
        }

        const nodes = nodesRef.current;
        const timestamp = Date.now();
        for (const id of nodes.keys()) {
            if (!nodeIds.has(id)) nodes.delete(id);
        }
        for (const id of nodeIds) {
            if (!nodes.has(id)) {
                let nx = (Math.random() - 0.5) * 200;
                let ny = (Math.random() - 0.5) * 200;
                for (const t of transitions) {
                    if (t.from === id && nodes.has(t.to)) {
                        const neighbor = nodes.get(t.to)!;
                        nx = neighbor.x + (Math.random() - 0.5) * 60;
                        ny = neighbor.y + (Math.random() - 0.5) * 60;
                        break;
                    }
                    if (t.to === id && nodes.has(t.from)) {
                        const neighbor = nodes.get(t.from)!;
                        nx = neighbor.x + (Math.random() - 0.5) * 60;
                        ny = neighbor.y + (Math.random() - 0.5) * 60;
                        break;
                    }
                }
                nodes.set(id, { id, x: nx, y: ny, vx: 0, vy: 0, firstSeen: timestamp, lastSeen: timestamp });
            } else {
                nodes.get(id)!.lastSeen = timestamp;
            }
        }
        edgesRef.current = newEdges;
        cachedNodesRef.current = Array.from(nodesRef.current.values());
        cachedEdgesRef.current = Array.from(newEdges.values());
        awakeRef.current = true;
        dirtyRef.current = true;
    }, [entries]);

    // Grouped mode: populate from Louvain result
    useEffect(() => {
        if (activeTab === "grouped" && groupedResult) {
            const nodes = nodesRef.current;
            const edges = edgesRef.current;
            const oldPositions = new Map<string, { x: number; y: number }>();
            for (const [id, node] of nodes) oldPositions.set(id, { x: node.x, y: node.y });

            nodes.clear();
            edges.clear();
            for (const nodeId of groupedResult.graph.nodes) {
                const old = oldPositions.get(nodeId);
                nodes.set(nodeId, {
                    id: nodeId,
                    x: old?.x ?? (Math.random() - 0.5) * 200,
                    y: old?.y ?? (Math.random() - 0.5) * 200,
                    vx: 0, vy: 0, firstSeen: 0, lastSeen: 0,
                });
            }
            for (const [key, weight] of groupedResult.graph.edges) {
                const sep = key.indexOf("\0");
                const from = key.slice(0, sep);
                const to = key.slice(sep + 1);
                edges.set(`${from}->${to}`, { from, to, weight });
            }
            cachedNodesRef.current = Array.from(nodes.values());
            cachedEdgesRef.current = Array.from(edges.values());
            awakeRef.current = true;
            dirtyRef.current = true;
        }
        if (activeTab === "raw") processedRef.current = 0;
    }, [activeTab, groupedResult]);

    // Hooks
    const { draw } = useCanvasRenderer({
        canvasRef, canvasWrapRef, tooltipRef,
        cachedNodesRef, cachedEdgesRef, nodesRef,
        panRef, zoomRef, dirtyRef, hoverIdRef, dimRef,
        groupedResultRef, activeTabRef,
    });

    useForceSimulation({
        cachedNodesRef, cachedEdgesRef, nodesRef, physicsRef,
        awakeRef, dirtyRef, dragRef, rafRef, processEntries, draw,
    });

    const { toggleFullscreen, fitToView } = useCanvasInteraction({
        canvasRef, containerRef, nodesRef, panRef, zoomRef,
        awakeRef, dirtyRef, hoverIdRef, dragRef, cachedNodesRef,
        setHoverNodeId, setIsFullscreen,
    });

    const tooltipStats = useTooltipStats(hoverNodeId, edgesRef);

    return (
        <div ref={containerRef} className="relative flex h-full w-full bg-background">
            <div ref={canvasWrapRef} className="relative flex-1 overflow-hidden">
                <canvas ref={canvasRef} className="block h-full w-full" />
                <NodeTooltip
                    hoverNodeId={hoverNodeId}
                    nodesRef={nodesRef}
                    tooltipRef={tooltipRef}
                    stats={tooltipStats}
                />
                <GraphToolbar
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                    isFullscreen={isFullscreen}
                    onToggleFullscreen={toggleFullscreen}
                    onFitToView={fitToView}
                    physicsOpen={physicsOpen}
                    onTogglePhysics={() => setPhysicsOpen(o => !o)}
                    dimMode={dimMode}
                    onToggleDim={() => {
                        setDimMode(d => { dimRef.current = !d; return !d; });
                    }}
                    panelOpen={panelOpen}
                    onTogglePanel={() => setPanelOpen(o => !o)}
                    physics={physics}
                    physicsRef={physicsRef}
                    onPhysicsChange={setPhysics}
                    awakeRef={awakeRef}
                    onClear={onClear}
                />
            </div>
            {panelOpen && (
                <GraphSidePanel
                    activeTab={activeTab}
                    panelWidth={panelWidth}
                    onPanelWidthChange={setPanelWidth}
                    groupedResult={groupedResult}
                    communityBreakdown={communityBreakdown}
                    latestTransitionsCount={latestTransitions.length}
                    nodesCount={nodesRef.current.size}
                    edgesCount={edgesRef.current.size}
                    resolution={resolution}
                    setResolution={setResolution}
                    hubThreshold={hubThreshold}
                    setHubThreshold={setHubThreshold}
                    hubMinSources={hubMinSources}
                    setHubMinSources={setHubMinSources}
                    sentinelPassthroughMs={sentinelPassthroughMs}
                    setSentinelPassthroughMs={setSentinelPassthroughMs}
                    sentinelBreakMs={sentinelBreakMs}
                    setSentinelBreakMs={setSentinelBreakMs}
                    transientDwellMs={transientDwellMs}
                    setTransientDwellMs={setTransientDwellMs}
                    targetPerChunk={targetPerChunk}
                    setTargetPerChunk={setTargetPerChunk}
                />
            )}
        </div>
    );
}
