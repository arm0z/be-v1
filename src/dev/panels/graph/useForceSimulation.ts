import { useCallback, useEffect, type MutableRefObject } from "react";
import type { Edge, Node, PhysicsParams } from "./types";
import { ENERGY_THRESHOLD, MIN_DIST } from "./types";

export function useForceSimulation(opts: {
    cachedNodesRef: MutableRefObject<Node[]>;
    cachedEdgesRef: MutableRefObject<Edge[]>;
    nodesRef: MutableRefObject<Map<string, Node>>;
    physicsRef: MutableRefObject<PhysicsParams>;
    awakeRef: MutableRefObject<boolean>;
    dirtyRef: MutableRefObject<boolean>;
    dragRef: MutableRefObject<unknown>;
    rafRef: MutableRefObject<number>;
    processEntries: () => void;
    draw: () => void;
}) {
    const {
        cachedNodesRef, cachedEdgesRef, nodesRef, physicsRef,
        awakeRef, dirtyRef, dragRef, rafRef, processEntries, draw,
    } = opts;

    const tick = useCallback(() => {
        const nodes = cachedNodesRef.current;
        const edges = cachedEdgesRef.current;
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

        dirtyRef.current = true;
        if (totalEnergy < ENERGY_THRESHOLD) awakeRef.current = false;
    }, [cachedNodesRef, cachedEdgesRef, nodesRef, physicsRef, awakeRef, dirtyRef]);

    useEffect(() => {
        let running = true;

        function loop() {
            if (!running) return;
            processEntries();
            if (awakeRef.current && !dragRef.current) tick();
            if (dirtyRef.current) {
                dirtyRef.current = false;
                draw();
            }
            rafRef.current = requestAnimationFrame(loop);
        }

        rafRef.current = requestAnimationFrame(loop);
        return () => {
            running = false;
            cancelAnimationFrame(rafRef.current);
        };
    }, [processEntries, tick, draw, awakeRef, dirtyRef, dragRef, rafRef]);
}
