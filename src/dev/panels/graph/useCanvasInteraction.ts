import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Node } from "./types";
import { HIT_RADIUS } from "./types";

type DragState = {
    type: "pan" | "node";
    nodeId?: string;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
} | null;

export function useCanvasInteraction(opts: {
    canvasRef: MutableRefObject<HTMLCanvasElement | null>;
    containerRef: MutableRefObject<HTMLDivElement | null>;
    nodesRef: MutableRefObject<Map<string, Node>>;
    panRef: MutableRefObject<{ x: number; y: number }>;
    zoomRef: MutableRefObject<number>;
    awakeRef: MutableRefObject<boolean>;
    dirtyRef: MutableRefObject<boolean>;
    hoverIdRef: MutableRefObject<string | null>;
    dragRef: MutableRefObject<DragState>;
    cachedNodesRef: MutableRefObject<Node[]>;
    setHoverNodeId: Dispatch<SetStateAction<string | null>>;
    setIsFullscreen: Dispatch<SetStateAction<boolean>>;
}) {
    const {
        canvasRef, containerRef, nodesRef, panRef, zoomRef,
        awakeRef, dirtyRef, hoverIdRef, dragRef, cachedNodesRef,
        setHoverNodeId, setIsFullscreen,
    } = opts;

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
        [canvasRef, zoomRef, panRef, nodesRef],
    );

    // pointer interactions
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        function onMouseDown(e: MouseEvent) {
            hoverIdRef.current = null;
            setHoverNodeId(null);
            dirtyRef.current = true;

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
            if (canvas) canvas.style.cursor = "grabbing";
        }

        function onDragMove(e: MouseEvent) {
            const drag = dragRef.current;
            if (!drag) return;

            dirtyRef.current = true;
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
                node.x = (e.clientX - rect.left - rect.width / 2 - pan.x) / zoom;
                node.y = (e.clientY - rect.top - rect.height / 2 - pan.y) / zoom;
                node.vx = 0;
                node.vy = 0;
                awakeRef.current = true;
            }
        }

        function onMouseUp() {
            dragRef.current = null;
            dirtyRef.current = true;
            if (canvas) canvas.style.cursor = "grab";
        }

        function onCanvasMove(e: MouseEvent) {
            if (dragRef.current) return;
            const node = hitTest(e.clientX, e.clientY);
            const id = node?.id ?? null;
            if (id !== hoverIdRef.current) {
                hoverIdRef.current = id;
                dirtyRef.current = true;
                setHoverNodeId(id);
            }
            if (canvas) canvas.style.cursor = id ? "pointer" : "grab";
        }

        function onCanvasLeave() {
            if (!dragRef.current && hoverIdRef.current) {
                hoverIdRef.current = null;
                dirtyRef.current = true;
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
            dirtyRef.current = true;
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
    }, [hitTest, canvasRef, hoverIdRef, dirtyRef, dragRef, panRef, zoomRef, nodesRef, awakeRef, setHoverNodeId]);

    // fullscreen tracking
    useEffect(() => {
        function onChange() {
            setIsFullscreen(!!document.fullscreenElement);
        }
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, [setIsFullscreen]);

    const toggleFullscreen = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            el.requestFullscreen();
        }
    }, [containerRef]);

    const fitToView = useCallback(() => {
        const nodes = cachedNodesRef.current;
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
        dirtyRef.current = true;
    }, [cachedNodesRef, canvasRef, zoomRef, panRef, dirtyRef]);

    return { toggleFullscreen, fitToView };
}
