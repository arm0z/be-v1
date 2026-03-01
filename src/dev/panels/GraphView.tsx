import {
    Boxes,
    Eclipse,
    Expand,
    PanelRight,
    Scan,
    Settings2,
    Shrink,
    Trash2,
    Waypoints,
} from "lucide-react";
import type { DirectedGraph, LouvainResult, PreprocessResult, Transition } from "@/aggregation/types";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildDirectedGraph, directedLouvain } from "@/aggregation/directed-louvain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { DevEntry } from "@/event/dev";
import { preprocess } from "@/aggregation/preprocess";

type Props = { entries: DevEntry[]; onClear?: () => void };

type Node = {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    firstSeen: number;
    lastSeen: number;
};
type Edge = { from: string; to: string; weight: number };

const DEFAULT_CHARGE_K = 800;
const DEFAULT_SPRING_K = 0.02;
const DEFAULT_REST_LENGTH = 120;
const DEFAULT_CENTER_K = 0.005;
const DEFAULT_DAMPING = 0.85;
const MIN_DIST = 20;
const ENERGY_THRESHOLD = 0.05;
const NODE_RADIUS = 8;
const HIT_RADIUS = 16;
const DOT_SPACING = 24;
const MAX_DOTS = 5000;

function fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

const COMMUNITY_COLORS = [
    "hsl(210, 80%, 60%)",
    "hsl(150, 70%, 50%)",
    "hsl(30, 90%, 60%)",
    "hsl(280, 70%, 60%)",
    "hsl(0, 80%, 60%)",
    "hsl(60, 80%, 50%)",
    "hsl(180, 70%, 50%)",
    "hsl(330, 70%, 60%)",
];

function getCommunityColor(communityId: string, communityIds: string[]): string {
    const index = communityIds.indexOf(communityId);
    return COMMUNITY_COLORS[index % COMMUNITY_COLORS.length];
}

function convexHull(points: [number, number][]): [number, number][] {
    if (points.length < 3) return points;
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    function cross(o: [number, number], a: [number, number], b: [number, number]): number {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }

    const lower: [number, number][] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop();
        }
        lower.push(p);
    }

    const upper: [number, number][] = [];
    for (const p of [...sorted].reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop();
        }
        upper.push(p);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

export function GraphView({ entries, onClear }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasWrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);

    const nodesRef = useRef<Map<string, Node>>(new Map());
    const edgesRef = useRef<Map<string, Edge>>(new Map());
    const processedRef = useRef(0);

    const panRef = useRef({ x: 0, y: 0 });
    const zoomRef = useRef(1);
    const awakeRef = useRef(true);
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
    const [dimMode, setDimMode] = useState(false);
    const dimRef = useRef(false);
    const [physicsOpen, setPhysicsOpen] = useState(false);

    const physicsRef = useRef({
        chargeK: DEFAULT_CHARGE_K,
        springK: DEFAULT_SPRING_K,
        restLength: DEFAULT_REST_LENGTH,
        centerK: DEFAULT_CENTER_K,
        damping: DEFAULT_DAMPING,
    });
    const [physics, setPhysics] = useState({ ...physicsRef.current });

    // Tunable algorithm parameters (side panel controls)
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

    // Compute grouped graph when in grouped mode
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
            sentinelPassthroughMs,
            sentinelBreakMs,
            transientDwellMs,
            hubThresholdPercent: hubThreshold,
            hubMinSources,
            targetPerChunk,
        });

        const graph = buildDirectedGraph(pr.transitions);
        const louvain = directedLouvain(graph, resolution);

        const result = { pr, graph, louvain };
        groupedResultRef.current = result;
        return result;
    }, [
        activeTab, latestTransitions,
        resolution, hubThreshold, hubMinSources,
        sentinelPassthroughMs, sentinelBreakMs,
        transientDwellMs, targetPerChunk,
    ]);

    const activeTabRef = useRef(activeTab);
    activeTabRef.current = activeTab;

    // --- data extraction (snapshot-based rebuild, raw mode only) ---
    const processEntries = useCallback(() => {
        // entries were cleared — reset graph state
        if (entries.length < processedRef.current) {
            nodesRef.current.clear();
            edgesRef.current.clear();
            processedRef.current = 0;
        }

        // In grouped mode, data comes from the groupedResult effect
        if (activeTabRef.current === "grouped") {
            processedRef.current = entries.length;
            return;
        }

        // Find the latest state.snapshot entry since last processed
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

        // Aggregate transitions into edges and collect node IDs
        const newEdges = new Map<string, Edge>();
        const nodeIds = new Set<string>();
        for (const t of transitions) {
            nodeIds.add(t.from);
            nodeIds.add(t.to);
            const key = `${t.from}->${t.to}`;
            const existing = newEdges.get(key);
            if (existing) {
                existing.weight++;
            } else {
                newEdges.set(key, { from: t.from, to: t.to, weight: 1 });
            }
        }

        // Update nodes — preserve positions for existing, add new ones near neighbors
        const nodes = nodesRef.current;
        const timestamp = Date.now();

        // Remove nodes no longer in the transition set
        for (const id of nodes.keys()) {
            if (!nodeIds.has(id)) nodes.delete(id);
        }

        // Add new nodes, positioned near an existing neighbor if possible
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
                nodes.set(id, {
                    id,
                    x: nx,
                    y: ny,
                    vx: 0,
                    vy: 0,
                    firstSeen: timestamp,
                    lastSeen: timestamp,
                });
            } else {
                nodes.get(id)!.lastSeen = timestamp;
            }
        }

        edgesRef.current = newEdges;
        awakeRef.current = true;
    }, [entries]);

    // --- grouped mode: populate nodes/edges from Louvain result ---
    useEffect(() => {
        if (activeTab === "grouped" && groupedResult) {
            const nodes = nodesRef.current;
            const edges = edgesRef.current;
            // Preserve existing node positions where possible
            const oldPositions = new Map<string, { x: number; y: number }>();
            for (const [id, node] of nodes) {
                oldPositions.set(id, { x: node.x, y: node.y });
            }

            nodes.clear();
            edges.clear();

            for (const nodeId of groupedResult.graph.nodes) {
                const old = oldPositions.get(nodeId);
                nodes.set(nodeId, {
                    id: nodeId,
                    x: old?.x ?? (Math.random() - 0.5) * 200,
                    y: old?.y ?? (Math.random() - 0.5) * 200,
                    vx: 0, vy: 0,
                    firstSeen: 0, lastSeen: 0,
                });
            }

            for (const [key, weight] of groupedResult.graph.edges) {
                const sep = key.indexOf("\0");
                const from = key.slice(0, sep);
                const to = key.slice(sep + 1);
                edges.set(`${from}->${to}`, { from, to, weight });
            }

            awakeRef.current = true;
        }
        // When switching back to raw, force reprocessing
        if (activeTab === "raw") {
            processedRef.current = 0;
        }
    }, [activeTab, groupedResult]);

    // --- force simulation ---
    const tick = useCallback(() => {
        const nodes = Array.from(nodesRef.current.values());
        const edges = Array.from(edgesRef.current.values());
        if (nodes.length === 0) return;

        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < MIN_DIST) dist = MIN_DIST;
                const force = physicsRef.current.chargeK / (dist * dist);
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx -= fx;
                a.vy -= fy;
                b.vx += fx;
                b.vy += fy;
            }
        }

        for (const edge of edges) {
            const a = nodesRef.current.get(edge.from);
            const b = nodesRef.current.get(edge.to);
            if (!a || !b) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const displacement = dist - physicsRef.current.restLength;
            const force = physicsRef.current.springK * displacement;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
        }

        let totalEnergy = 0;
        for (const node of nodes) {
            node.vx -= node.x * physicsRef.current.centerK;
            node.vy -= node.y * physicsRef.current.centerK;
            node.vx *= physicsRef.current.damping;
            node.vy *= physicsRef.current.damping;
            node.x += node.vx;
            node.y += node.vy;
            totalEnergy += node.vx * node.vx + node.vy * node.vy;
        }

        if (totalEnergy < ENERGY_THRESHOLD) awakeRef.current = false;
    }, []);

    // --- canvas rendering ---
    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const nodes = Array.from(nodesRef.current.values());
        const edges = Array.from(edgesRef.current.values());
        const w = canvas.width;
        const h = canvas.height;
        const dpr = window.devicePixelRatio || 1;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#09090b";
        ctx.fillRect(0, 0, w, h);

        const zoom = zoomRef.current;
        const pan = panRef.current;
        ctx.setTransform(
            zoom * dpr,
            0,
            0,
            zoom * dpr,
            w / 2 + pan.x * dpr,
            h / 2 + pan.y * dpr,
        );

        // --- dot grid ---
        const halfW = w / (2 * zoom * dpr);
        const halfH = h / (2 * zoom * dpr);
        const vcx = -pan.x / zoom;
        const vcy = -pan.y / zoom;
        const startX = Math.floor((vcx - halfW) / DOT_SPACING) * DOT_SPACING;
        const endX = Math.ceil((vcx + halfW) / DOT_SPACING) * DOT_SPACING;
        const startY = Math.floor((vcy - halfH) / DOT_SPACING) * DOT_SPACING;
        const endY = Math.ceil((vcy + halfH) / DOT_SPACING) * DOT_SPACING;
        const cols = (endX - startX) / DOT_SPACING + 1;
        const rows = (endY - startY) / DOT_SPACING + 1;

        if (cols * rows < MAX_DOTS) {
            const dotSize = 1.2 / zoom;
            ctx.fillStyle = "rgba(80,80,80,0.35)";
            for (let x = startX; x <= endX; x += DOT_SPACING) {
                for (let y = startY; y <= endY; y += DOT_SPACING) {
                    ctx.fillRect(
                        x - dotSize / 2,
                        y - dotSize / 2,
                        dotSize,
                        dotSize,
                    );
                }
            }
        }

        // --- community hulls (grouped mode) ---
        const gr = groupedResultRef.current;
        if (activeTabRef.current === "grouped" && gr) {
            const uniqueCommunities = [...new Set(gr.louvain.communities.values())];

            for (const communityId of uniqueCommunities) {
                const communityNodes: Node[] = [];
                for (const [nodeId, cId] of gr.louvain.communities) {
                    if (cId === communityId) {
                        const node = nodesRef.current.get(nodeId);
                        if (node) communityNodes.push(node);
                    }
                }

                if (communityNodes.length < 2) continue;

                const hull = convexHull(communityNodes.map(n => [n.x, n.y]));
                if (hull.length < 3) continue;

                const color = getCommunityColor(communityId, uniqueCommunities);
                const padding = 20;
                const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
                const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;

                const expanded = hull.map(([x, y]) => {
                    const dx = x - cx;
                    const dy = y - cy;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    return [x + (dx / dist) * padding, y + (dy / dist) * padding] as [number, number];
                });

                ctx.beginPath();
                ctx.moveTo(expanded[0][0], expanded[0][1]);
                for (let i = 1; i < expanded.length; i++) {
                    ctx.lineTo(expanded[i][0], expanded[i][1]);
                }
                ctx.closePath();
                ctx.fillStyle = color.replace(")", ", 0.08)").replace("hsl(", "hsla(");
                ctx.fill();
                ctx.strokeStyle = color.replace(")", ", 0.3)").replace("hsl(", "hsla(");
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }

        // --- edges ---
        const hoverId = hoverIdRef.current;
        const dim = dimRef.current && hoverId !== null;
        const connectedSet = new Set<string>();
        if (!!dim) {
            connectedSet.add(hoverId);
            for (const edge of edges) {
                if (edge.from === hoverId) connectedSet.add(edge.to);
                if (edge.to === hoverId) connectedSet.add(edge.from);
            }
        }
        const EDGE_OFFSET = 5;
        for (const edge of edges) {
            const a = nodesRef.current.get(edge.from);
            const b = nodesRef.current.get(edge.to);
            if (!a || !b) continue;

            // offset so parallel edges (A→B and B→A) don't overlap
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = (-dy / len) * EDGE_OFFSET;
            const ny = (dx / len) * EDGE_OFFSET;

            const ax = a.x + nx;
            const ay = a.y + ny;
            const bx = b.x + nx;
            const by = b.y + ny;

            const isOutbound = hoverId !== null && edge.from === hoverId;
            const isInbound = hoverId !== null && edge.to === hoverId;

            const color = isOutbound
                ? "rgba(96,165,250,0.6)"
                : isInbound
                  ? "rgba(74,222,128,0.6)"
                  : "rgba(160,160,160,0.4)";
            const lineW = 1 + Math.log2(Math.max(edge.weight, 1));

            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.strokeStyle = color;
            ctx.lineWidth = lineW;
            ctx.stroke();

            // arrowhead at target node edge, sized by weight (capped)
            const udx = (bx - ax) / len;
            const udy = (by - ay) / len;
            const arrowLen = Math.min(
                4 + Math.log2(Math.max(edge.weight, 1)) * 2,
                12,
            );
            const arrowW = arrowLen * 0.6;
            const tipX = bx - udx * NODE_RADIUS;
            const tipY = by - udy * NODE_RADIUS;

            ctx.beginPath();
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(
                tipX - udx * arrowLen + udy * arrowW,
                tipY - udy * arrowLen - udx * arrowW,
            );
            ctx.lineTo(
                tipX - udx * arrowLen - udy * arrowW,
                tipY - udy * arrowLen + udx * arrowW,
            );
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();

            const isRelated = isOutbound || isInbound;
            if (!dim || isRelated) {
                const mx = (ax + bx) / 2;
                const my = (ay + by) / 2;
                ctx.font = "10px sans-serif";
                ctx.fillStyle = isOutbound
                    ? "rgba(96,165,250,0.9)"
                    : isInbound
                      ? "rgba(74,222,128,0.9)"
                      : "rgba(160,160,160,0.6)";
                ctx.textAlign = "center";
                ctx.textBaseline = "bottom";
                ctx.fillText(String(edge.weight), mx, my - 4);
            }
        }

        // --- nodes ---
        for (const node of nodes) {
            const isUnknown = node.id === "UNKNOWN";
            const isHovered = node.id === hoverId;

            // hover highlight ring
            if (isHovered) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, NODE_RADIUS + 5, 0, Math.PI * 2);
                ctx.strokeStyle = "rgba(120,180,255,0.35)";
                ctx.lineWidth = 2.5;
                ctx.stroke();
            }

            const isDimmed = dim && !connectedSet.has(node.id);
            ctx.beginPath();
            ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);

            if (isDimmed) {
                ctx.fillStyle = "rgba(120,120,120,0.15)";
            } else if (activeTabRef.current === "grouped" && gr) {
                const communityId = gr.louvain.communities.get(node.id);
                const uniqueCommunities = [...new Set(gr.louvain.communities.values())];
                ctx.fillStyle = communityId
                    ? getCommunityColor(communityId, uniqueCommunities)
                    : "rgba(120,120,120,0.4)";
            } else if (isUnknown) {
                ctx.fillStyle = "rgba(120,120,120,0.4)";
            } else if (isHovered) {
                ctx.fillStyle = "hsl(210, 90%, 68%)";
            } else {
                ctx.fillStyle = "hsl(210, 80%, 60%)";
            }
            ctx.fill();

            if (isUnknown) {
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = "rgba(160,160,160,0.8)";
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Source ID label
            const showLabel = !dim || connectedSet.has(node.id);
            if (showLabel) {
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.font = "11px sans-serif";
                ctx.fillStyle = "rgba(220,220,220,0.9)";
                ctx.fillText(node.id, node.x, node.y + NODE_RADIUS + 4);
            }
        }

        // --- empty state ---
        if (nodes.length === 0) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.font = "13px sans-serif";
            ctx.fillStyle = "rgba(160,160,160,0.6)";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(
                "No graph data yet \u2014 edges appear as transitions flow",
                w / dpr / 2,
                h / dpr / 2,
            );
        }

        // --- tooltip positioning (bottom-right) ---
        const tooltipEl = tooltipRef.current;
        if (tooltipEl && hoverId) {
            tooltipEl.style.transform = "";
            tooltipEl.style.opacity = "1";
        }
    }, []);

    // --- animation loop ---
    useEffect(() => {
        let running = true;

        function loop() {
            if (!running) return;
            processEntries();
            if (awakeRef.current && !dragRef.current) tick();
            draw();
            rafRef.current = requestAnimationFrame(loop);
        }

        rafRef.current = requestAnimationFrame(loop);
        return () => {
            running = false;
            cancelAnimationFrame(rafRef.current);
        };
    }, [processEntries, tick, draw]);

    // --- canvas resize ---
    useEffect(() => {
        const wrap = canvasWrapRef.current;
        const canvas = canvasRef.current;
        if (!wrap || !canvas) return;

        const ro = new ResizeObserver(() => {
            const dpr = window.devicePixelRatio || 1;
            const rect = wrap.getBoundingClientRect();
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
        });

        ro.observe(wrap);
        return () => ro.disconnect();
    }, []);

    // --- hit test ---
    const hitTest = useCallback(
        (clientX: number, clientY: number): Node | null => {
            const canvas = canvasRef.current;
            if (!canvas) return null;
            const rect = canvas.getBoundingClientRect();
            const zoom = zoomRef.current;
            const pan = panRef.current;

            const gx = (clientX - rect.left - rect.width / 2 - pan.x) / zoom;
            const gy = (clientY - rect.top - rect.height / 2 - pan.y) / zoom;

            for (const node of nodesRef.current.values()) {
                const dx = node.x - gx;
                const dy = node.y - gy;
                if (dx * dx + dy * dy < HIT_RADIUS * HIT_RADIUS) return node;
            }
            return null;
        },
        [],
    );

    // --- pointer interactions ---
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        function onMouseDown(e: MouseEvent) {
            hoverIdRef.current = null;
            setHoverNodeId(null);

            const node = hitTest(e.clientX, e.clientY);
            if (node) {
                dragRef.current = {
                    type: "node",
                    nodeId: node.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    startPanX: 0,
                    startPanY: 0,
                };
            } else {
                dragRef.current = {
                    type: "pan",
                    startX: e.clientX,
                    startY: e.clientY,
                    startPanX: panRef.current.x,
                    startPanY: panRef.current.y,
                };
            }
            canvas!.style.cursor = "grabbing";
        }

        function onDragMove(e: MouseEvent) {
            const drag = dragRef.current;
            if (!drag) return;

            if (drag.type === "pan") {
                panRef.current.x = drag.startPanX + (e.clientX - drag.startX);
                panRef.current.y = drag.startPanY + (e.clientY - drag.startY);
            } else if (drag.type === "node" && drag.nodeId) {
                const node = nodesRef.current.get(drag.nodeId);
                if (!node) return;
                const canvas = canvasRef.current;
                if (!canvas) return;
                const rect = canvas.getBoundingClientRect();
                const zoom = zoomRef.current;
                const pan = panRef.current;
                node.x =
                    (e.clientX - rect.left - rect.width / 2 - pan.x) / zoom;
                node.y =
                    (e.clientY - rect.top - rect.height / 2 - pan.y) / zoom;
                node.vx = 0;
                node.vy = 0;
                awakeRef.current = true;
            }
        }

        function onMouseUp() {
            dragRef.current = null;
            canvas!.style.cursor = "grab";
        }

        function onCanvasMove(e: MouseEvent) {
            if (dragRef.current) return;
            const node = hitTest(e.clientX, e.clientY);
            const id = node?.id ?? null;
            if (id !== hoverIdRef.current) {
                hoverIdRef.current = id;
                setHoverNodeId(id);
            }
            canvas!.style.cursor = id ? "pointer" : "grab";
        }

        function onCanvasLeave() {
            if (!dragRef.current && hoverIdRef.current) {
                hoverIdRef.current = null;
                setHoverNodeId(null);
            }
        }

        function onWheel(e: WheelEvent) {
            e.preventDefault();
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left - rect.width / 2;
            const my = e.clientY - rect.top - rect.height / 2;

            const oldZoom = zoomRef.current;
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            const newZoom = Math.max(0.1, Math.min(10, oldZoom * factor));

            panRef.current.x += mx * (1 - newZoom / oldZoom);
            panRef.current.y += my * (1 - newZoom / oldZoom);
            zoomRef.current = newZoom;
        }

        canvas.style.cursor = "grab";
        canvas.addEventListener("mousedown", onMouseDown);
        canvas.addEventListener("mousemove", onCanvasMove);
        canvas.addEventListener("mouseleave", onCanvasLeave);
        window.addEventListener("mousemove", onDragMove);
        window.addEventListener("mouseup", onMouseUp);
        canvas.addEventListener("wheel", onWheel, { passive: false });

        return () => {
            canvas.removeEventListener("mousedown", onMouseDown);
            canvas.removeEventListener("mousemove", onCanvasMove);
            canvas.removeEventListener("mouseleave", onCanvasLeave);
            window.removeEventListener("mousemove", onDragMove);
            window.removeEventListener("mouseup", onMouseUp);
            canvas.removeEventListener("wheel", onWheel);
        };
    }, [hitTest]);

    // --- fullscreen tracking ---
    useEffect(() => {
        function onChange() {
            setIsFullscreen(!!document.fullscreenElement);
        }
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    const toggleFullscreen = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            el.requestFullscreen();
        }
    }, []);

    const fitToView = useCallback(() => {
        const nodes = Array.from(nodesRef.current.values());
        if (nodes.length === 0) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const cw = canvas.width / dpr;
        const ch = canvas.height / dpr;
        const padding = 60;

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const node of nodes) {
            if (node.x < minX) minX = node.x;
            if (node.x > maxX) maxX = node.x;
            if (node.y < minY) minY = node.y;
            if (node.y > maxY) maxY = node.y;
        }

        const bw = maxX - minX || 1;
        const bh = maxY - minY || 1;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        const zoom = Math.min(
            (cw - padding * 2) / bw,
            (ch - padding * 2) / bh,
            2,
        );

        zoomRef.current = zoom;
        panRef.current.x = -cx * zoom;
        panRef.current.y = -cy * zoom;
    }, []);

    // --- tooltip stats ---
    function getStats(nodeId: string) {
        const inbound: { from: string; weight: number }[] = [];
        const outbound: { to: string; weight: number }[] = [];
        for (const edge of edgesRef.current.values()) {
            if (edge.to === nodeId)
                inbound.push({ from: edge.from, weight: edge.weight });
            if (edge.from === nodeId)
                outbound.push({ to: edge.to, weight: edge.weight });
        }
        const totalWeight = [...inbound, ...outbound].reduce(
            (s, e) => s + e.weight,
            0,
        );
        return {
            inbound,
            outbound,
            totalWeight,
            degree: inbound.length + outbound.length,
        };
    }

    // --- tooltip content ---
    let tooltipContent: React.ReactNode = null;
    if (hoverNodeId) {
        const node = nodesRef.current.get(hoverNodeId);
        if (node) {
            const stats = getStats(hoverNodeId);
            tooltipContent = (
                <div
                    ref={tooltipRef}
                    className="pointer-events-none absolute bottom-3 right-3 z-10 w-52 rounded-lg border border-border/50 bg-popover/95 p-3 text-xs text-popover-foreground opacity-0 shadow-xl backdrop-blur-sm"
                >
                    <div className="truncate text-sm font-semibold">
                        {node.id}
                    </div>

                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 border-t border-border/30 pt-2">
                        <span className="text-muted-foreground">Degree</span>
                        <span className="text-right tabular-nums">
                            {stats.degree}
                        </span>
                        <span className="text-muted-foreground">Inbound</span>
                        <span className="text-right tabular-nums">
                            {stats.inbound.length}
                        </span>
                        <span className="text-muted-foreground">Outbound</span>
                        <span className="text-right tabular-nums">
                            {stats.outbound.length}
                        </span>
                        <span className="text-muted-foreground">Total wt.</span>
                        <span className="text-right tabular-nums">
                            {stats.totalWeight}
                        </span>
                    </div>

                    {stats.outbound.length > 0 && (
                        <div className="mt-2 space-y-px border-t border-border/30 pt-2">
                            <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
                                Outbound
                            </span>
                            {stats.outbound.map((e) => (
                                <div key={`o-${e.to}`}>
                                    <div className="flex justify-between gap-2">
                                        <span className="truncate text-muted-foreground">
                                            <span className="text-blue-400">
                                                &rarr;
                                            </span>{" "}
                                            {e.to}
                                        </span>
                                        <span className="shrink-0 tabular-nums">
                                            &times;{e.weight}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    {stats.inbound.length > 0 && (
                        <div className="mt-2 space-y-px border-t border-border/30 pt-2">
                            <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
                                Inbound
                            </span>
                            {stats.inbound.map((e) => (
                                <div key={`i-${e.from}`}>
                                    <div className="flex justify-between gap-2">
                                        <span className="truncate text-muted-foreground">
                                            <span className="text-emerald-400">
                                                &larr;
                                            </span>{" "}
                                            {e.from}
                                        </span>
                                        <span className="shrink-0 tabular-nums">
                                            &times;{e.weight}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 border-t border-border/30 pt-2 text-muted-foreground">
                        <span>First seen</span>
                        <span className="text-right tabular-nums text-foreground">
                            {fmtTime(node.firstSeen)}
                        </span>
                        <span>Last active</span>
                        <span className="text-right tabular-nums text-foreground">
                            {fmtTime(node.lastSeen)}
                        </span>
                    </div>
                </div>
            );
        }
    }

    return (
        <div
            ref={containerRef}
            className="relative flex h-full w-full bg-background"
        >
            <div
                ref={canvasWrapRef}
                className="relative flex-1 overflow-hidden"
            >
                <canvas ref={canvasRef} className="block h-full w-full" />
                {tooltipContent}
                <Tabs
                    value={activeTab}
                    onValueChange={(v) => setActiveTab(v as "raw" | "grouped")}
                    className="absolute left-2 top-2 z-10"
                >
                    <TabsList className="h-auto border border-border bg-popover/80 p-0.5 backdrop-blur-sm">
                        <TabsTrigger
                            value="raw"
                            className="h-auto px-2 py-0.5 text-xs"
                        >
                            <Waypoints className="size-3" />
                            Raw
                        </TabsTrigger>
                        <TabsTrigger
                            value="grouped"
                            className="h-auto px-2 py-0.5 text-xs"
                        >
                            <Boxes className="size-3" />
                            Grouped
                        </TabsTrigger>
                    </TabsList>
                </Tabs>
                <div className="absolute right-2 top-2 flex gap-1">
                    {onClear && (
                        <Button
                            variant="outline"
                            size="icon-xs"
                            onClick={onClear}
                            title="Clear all"
                        >
                            <Trash2 />
                        </Button>
                    )}
                    <Button
                        variant={physicsOpen ? "default" : "outline"}
                        size="icon-xs"
                        onClick={() => setPhysicsOpen((o) => !o)}
                        title={
                            physicsOpen ? "Close physics" : "Physics settings"
                        }
                    >
                        <Settings2 />
                    </Button>
                    <Button
                        variant={dimMode ? "default" : "outline"}
                        size="icon-xs"
                        onClick={() => {
                            setDimMode((d) => {
                                dimRef.current = !d;
                                return !d;
                            });
                        }}
                        title={dimMode ? "Enable dim mode" : "Disable dim mode"}
                    >
                        <Eclipse />
                    </Button>
                    <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={fitToView}
                        title="Fit to view"
                    >
                        <Scan />
                    </Button>
                    <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={toggleFullscreen}
                        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    >
                        {isFullscreen ? <Shrink /> : <Expand />}
                    </Button>
                    <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={() => setPanelOpen((o) => !o)}
                        title={panelOpen ? "Close panel" : "Open panel"}
                    >
                        <PanelRight />
                    </Button>
                </div>
                {physicsOpen && (
                    <div className="absolute bottom-2 left-2 z-10 w-56 rounded-lg border border-border/50 bg-popover/95 p-3 text-xs text-popover-foreground shadow-xl backdrop-blur-sm">
                        <div className="mb-2 font-semibold text-sm">
                            Physics
                        </div>
                        {[
                            {
                                label: "Repulsion",
                                key: "chargeK" as const,
                                min: 0,
                                max: 3000,
                                step: 50,
                                def: DEFAULT_CHARGE_K,
                            },
                            {
                                label: "Spring",
                                key: "springK" as const,
                                min: 0,
                                max: 0.1,
                                step: 0.002,
                                def: DEFAULT_SPRING_K,
                            },
                            {
                                label: "Rest length",
                                key: "restLength" as const,
                                min: 20,
                                max: 400,
                                step: 5,
                                def: DEFAULT_REST_LENGTH,
                            },
                            {
                                label: "Centering",
                                key: "centerK" as const,
                                min: 0,
                                max: 0.05,
                                step: 0.001,
                                def: DEFAULT_CENTER_K,
                            },
                            {
                                label: "Damping",
                                key: "damping" as const,
                                min: 0.5,
                                max: 0.99,
                                step: 0.01,
                                def: DEFAULT_DAMPING,
                            },
                        ].map((p) => (
                            <div key={p.key} className="mt-1.5">
                                <div className="flex justify-between text-muted-foreground">
                                    <span>{p.label}</span>
                                    <span className="tabular-nums">
                                        {physics[p.key]}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={p.min}
                                    max={p.max}
                                    step={p.step}
                                    value={physics[p.key]}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        physicsRef.current[p.key] = v;
                                        setPhysics({ ...physicsRef.current });
                                        awakeRef.current = true;
                                    }}
                                    className="mt-0.5 h-1 w-full cursor-pointer appearance-none rounded bg-border accent-blue-500"
                                />
                            </div>
                        ))}
                        <button
                            type="button"
                            className="mt-3 w-full rounded border border-border/50 px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                            onClick={() => {
                                physicsRef.current = {
                                    chargeK: DEFAULT_CHARGE_K,
                                    springK: DEFAULT_SPRING_K,
                                    restLength: DEFAULT_REST_LENGTH,
                                    centerK: DEFAULT_CENTER_K,
                                    damping: DEFAULT_DAMPING,
                                };
                                setPhysics({ ...physicsRef.current });
                                awakeRef.current = true;
                            }}
                        >
                            Reset defaults
                        </button>
                    </div>
                )}
            </div>
            {panelOpen && (
                <div className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-background">
                    <div className="border-b border-border px-3 py-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {activeTab === "grouped" ? "Algorithm Parameters" : "Graph Info"}
                        </h3>
                    </div>
                    <div className="dev-scrollbar flex-1 overflow-y-auto p-3 space-y-4 text-xs">
                        {activeTab === "grouped" ? (
                            <>
                                {/* Stats */}
                                {groupedResult && (
                                    <div className="space-y-2">
                                        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                            Results
                                        </div>
                                        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                                            <span className="text-muted-foreground">Modularity</span>
                                            <span className="text-right tabular-nums">
                                                {groupedResult.louvain.modularity.toFixed(4)}
                                            </span>
                                            <span className="text-muted-foreground">Communities</span>
                                            <span className="text-right tabular-nums">
                                                {new Set(groupedResult.louvain.communities.values()).size}
                                            </span>
                                            <span className="text-muted-foreground">Nodes</span>
                                            <span className="text-right tabular-nums">
                                                {groupedResult.graph.nodes.size}
                                            </span>
                                            <span className="text-muted-foreground">Edges</span>
                                            <span className="text-right tabular-nums">
                                                {groupedResult.graph.edges.size}
                                            </span>
                                            <span className="text-muted-foreground">Hubs</span>
                                            <span className="text-right tabular-nums">
                                                {groupedResult.pr.hubSources.size}
                                            </span>
                                            <span className="text-muted-foreground">Sentinels</span>
                                            <span className="text-right tabular-nums">
                                                {groupedResult.pr.sentinelCount}
                                            </span>
                                            <span className="text-muted-foreground">Excluded</span>
                                            <span className="text-right tabular-nums">
                                                {groupedResult.pr.excludedSources.size}
                                            </span>
                                        </div>
                                    </div>
                                )}
                                <div className="border-t border-border/50" />

                                {/* Louvain */}
                                <div className="space-y-2">
                                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                        Louvain
                                    </div>
                                    <div>
                                        <div className="flex justify-between text-muted-foreground">
                                            <span>Resolution ({"\u03B3"})</span>
                                            <span className="tabular-nums">{resolution.toFixed(2)}</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={0.1} max={3.0} step={0.05}
                                            value={resolution}
                                            onChange={(e) => setResolution(Number(e.target.value))}
                                            className="mt-0.5 h-1 w-full cursor-pointer appearance-none rounded bg-border accent-blue-500"
                                        />
                                        <div className="flex justify-between text-muted-foreground text-[10px]">
                                            <span>0.1 (larger)</span>
                                            <span>3.0 (smaller)</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="border-t border-border/50" />

                                {/* Off-browser */}
                                <div className="space-y-2">
                                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                        Off-browser sentinel
                                    </div>
                                    <div>
                                        <div className="flex justify-between text-muted-foreground">
                                            <span>Pass-through</span>
                                            <span className="tabular-nums">{(sentinelPassthroughMs / 1000).toFixed(1)}s</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={500} max={10000} step={500}
                                            value={sentinelPassthroughMs}
                                            onChange={(e) => setSentinelPassthroughMs(Number(e.target.value))}
                                            className="mt-0.5 h-1 w-full cursor-pointer appearance-none rounded bg-border accent-blue-500"
                                        />
                                    </div>
                                    <div>
                                        <div className="flex justify-between text-muted-foreground">
                                            <span>Break boundary</span>
                                            <span className="tabular-nums">{(sentinelBreakMs / 60000).toFixed(0)} min</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={60000} max={1800000} step={60000}
                                            value={sentinelBreakMs}
                                            onChange={(e) => setSentinelBreakMs(Number(e.target.value))}
                                            className="mt-0.5 h-1 w-full cursor-pointer appearance-none rounded bg-border accent-blue-500"
                                        />
                                    </div>
                                </div>
                                <div className="border-t border-border/50" />

                                {/* Transient */}
                                <div className="space-y-2">
                                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                        Transient detection
                                    </div>
                                    <div>
                                        <div className="flex justify-between text-muted-foreground">
                                            <span>Dwell threshold</span>
                                            <span className="tabular-nums">{transientDwellMs}ms</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={100} max={2000} step={100}
                                            value={transientDwellMs}
                                            onChange={(e) => setTransientDwellMs(Number(e.target.value))}
                                            className="mt-0.5 h-1 w-full cursor-pointer appearance-none rounded bg-border accent-blue-500"
                                        />
                                    </div>
                                </div>
                                <div className="border-t border-border/50" />

                                {/* Hub detection */}
                                <div className="space-y-2">
                                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                        Hub detection
                                    </div>
                                    <div>
                                        <div className="flex justify-between text-muted-foreground">
                                            <span>Threshold</span>
                                            <span className="tabular-nums">{(hubThreshold * 100).toFixed(0)}%</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={0.05} max={0.5} step={0.01}
                                            value={hubThreshold}
                                            onChange={(e) => setHubThreshold(Number(e.target.value))}
                                            className="mt-0.5 h-1 w-full cursor-pointer appearance-none rounded bg-border accent-blue-500"
                                        />
                                    </div>
                                    <div>
                                        <div className="flex justify-between text-muted-foreground">
                                            <span>Min sources</span>
                                            <span className="tabular-nums">{hubMinSources}</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={3} max={30} step={1}
                                            value={hubMinSources}
                                            onChange={(e) => setHubMinSources(Number(e.target.value))}
                                            className="mt-0.5 h-1 w-full cursor-pointer appearance-none rounded bg-border accent-blue-500"
                                        />
                                    </div>
                                    <div>
                                        <div className="flex justify-between text-muted-foreground">
                                            <span>Target per chunk</span>
                                            <span className="tabular-nums">{targetPerChunk}</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={2} max={10} step={1}
                                            value={targetPerChunk}
                                            onChange={(e) => setTargetPerChunk(Number(e.target.value))}
                                            className="mt-0.5 h-1 w-full cursor-pointer appearance-none rounded bg-border accent-blue-500"
                                        />
                                    </div>
                                </div>
                                <div className="border-t border-border/50" />

                                {/* Per-community breakdown */}
                                {groupedResult && (
                                    <div className="space-y-2">
                                        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                            Communities
                                        </div>
                                        {(() => {
                                            const communities = new Map<string, string[]>();
                                            for (const [nodeId, communityId] of groupedResult.louvain.communities) {
                                                let members = communities.get(communityId);
                                                if (!members) {
                                                    members = [];
                                                    communities.set(communityId, members);
                                                }
                                                members.push(nodeId);
                                            }
                                            const uniqueCommunities = [...communities.keys()];

                                            return [...communities.entries()].map(([communityId, members]) => (
                                                <div key={communityId} className="rounded border border-border/50 p-2">
                                                    <div className="flex items-center gap-2">
                                                        <div
                                                            className="h-2.5 w-2.5 rounded-full"
                                                            style={{ backgroundColor: getCommunityColor(communityId, uniqueCommunities) }}
                                                        />
                                                        <span className="font-medium">{members.length} nodes</span>
                                                    </div>
                                                    <div className="mt-1 space-y-px">
                                                        {members.map(id => (
                                                            <div key={id} className="truncate text-muted-foreground">{id}</div>
                                                        ))}
                                                    </div>
                                                </div>
                                            ));
                                        })()}
                                    </div>
                                )}
                            </>
                        ) : (
                            /* Raw panel */
                            <div className="space-y-3">
                                <div>
                                    <div className="text-muted-foreground">Transitions</div>
                                    <div className="text-lg tabular-nums">{latestTransitions.length}</div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground">Nodes</div>
                                    <div className="text-lg tabular-nums">{nodesRef.current.size}</div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground">Edges</div>
                                    <div className="text-lg tabular-nums">{edgesRef.current.size}</div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
