import { useCallback, useEffect, type MutableRefObject } from "react";
import type { DirectedGraph, LouvainResult, PreprocessResult } from "@/aggregation/types";
import type { Edge, Node } from "./types";
import { DOT_SPACING, MAX_DOTS, NODE_RADIUS } from "./types";
import { convexHull, getCommunityColor } from "./colors";
import { hslAlpha } from "@/lib/utils";

type GroupedResult = {
    pr: PreprocessResult;
    graph: DirectedGraph;
    louvain: LouvainResult;
} | null;

export function useCanvasRenderer(opts: {
    canvasRef: MutableRefObject<HTMLCanvasElement | null>;
    canvasWrapRef: MutableRefObject<HTMLDivElement | null>;
    tooltipRef: MutableRefObject<HTMLDivElement | null>;
    cachedNodesRef: MutableRefObject<Node[]>;
    cachedEdgesRef: MutableRefObject<Edge[]>;
    nodesRef: MutableRefObject<Map<string, Node>>;
    panRef: MutableRefObject<{ x: number; y: number }>;
    zoomRef: MutableRefObject<number>;
    dirtyRef: MutableRefObject<boolean>;
    hoverIdRef: MutableRefObject<string | null>;
    dimRef: MutableRefObject<boolean>;
    groupedResultRef: MutableRefObject<GroupedResult>;
    activeTabRef: MutableRefObject<"raw" | "grouped">;
}) {
    const {
        canvasRef, canvasWrapRef, tooltipRef,
        cachedNodesRef, cachedEdgesRef, nodesRef,
        panRef, zoomRef, dirtyRef, hoverIdRef, dimRef,
        groupedResultRef, activeTabRef,
    } = opts;

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const nodes = cachedNodesRef.current;
        const edges = cachedEdgesRef.current;
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
            zoom * dpr, 0, 0, zoom * dpr,
            w / 2 + pan.x * dpr,
            h / 2 + pan.y * dpr,
        );

        // dot grid
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
                    ctx.fillRect(x - dotSize / 2, y - dotSize / 2, dotSize, dotSize);
                }
            }
        }

        // community hulls (grouped mode)
        const gr = groupedResultRef.current;
        const uniqueCommunities = gr ? [...new Set(gr.louvain.communities.values())] : [];
        if (activeTabRef.current === "grouped" && gr) {
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
                ctx.fillStyle = hslAlpha(color, 0.08);
                ctx.fill();
                ctx.strokeStyle = hslAlpha(color, 0.3);
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }

        // edges
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

            const udx = (bx - ax) / len;
            const udy = (by - ay) / len;
            const arrowLen = Math.min(4 + Math.log2(Math.max(edge.weight, 1)) * 2, 12);
            const arrowW = arrowLen * 0.6;
            const tipX = bx - udx * NODE_RADIUS;
            const tipY = by - udy * NODE_RADIUS;

            ctx.beginPath();
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(tipX - udx * arrowLen + udy * arrowW, tipY - udy * arrowLen - udx * arrowW);
            ctx.lineTo(tipX - udx * arrowLen - udy * arrowW, tipY - udy * arrowLen + udx * arrowW);
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

        // nodes
        for (const node of nodes) {
            const isUnknown = node.id === "UNKNOWN";
            const isHovered = node.id === hoverId;

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

            const showLabel = !dim || connectedSet.has(node.id);
            if (showLabel) {
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.font = "11px sans-serif";
                ctx.fillStyle = "rgba(220,220,220,0.9)";
                ctx.fillText(node.id, node.x, node.y + NODE_RADIUS + 4);
            }
        }

        // empty state
        if (nodes.length === 0) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.font = "13px sans-serif";
            ctx.fillStyle = "rgba(160,160,160,0.6)";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(
                "No graph data yet \u2014 edges appear as transitions flow",
                w / dpr / 2, h / dpr / 2,
            );
        }

        // tooltip positioning
        const tooltipEl = tooltipRef.current;
        if (tooltipEl && hoverId) {
            tooltipEl.style.transform = "";
            tooltipEl.style.opacity = "1";
        }
    }, [
        canvasRef, cachedNodesRef, cachedEdgesRef, nodesRef,
        panRef, zoomRef, hoverIdRef, dimRef, groupedResultRef,
        activeTabRef, tooltipRef,
    ]);

    // canvas resize
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
            dirtyRef.current = true;
        });

        ro.observe(wrap);
        return () => ro.disconnect();
    }, [canvasWrapRef, canvasRef, dirtyRef]);

    return { draw };
}
