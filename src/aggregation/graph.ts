import type { Edge } from "./types.ts";
import { dev } from "../event/dev.ts";

export function createGraph() {
    const edges = new Map<string, Edge>();
    const urls = new Map<string, string>();

    function key(from: string, to: string): string {
        return `${from}\0${to}`;
    }

    function recordEdge(from: string, to: string): void {
        const k = key(from, to);
        const existing = edges.get(k);
        if (existing) {
            existing.weight++;
            dev.log(
                "graph",
                "edge.incremented",
                `${from} → ${to} (${existing.weight})`,
                { from, to, weight: existing.weight },
            );
        } else {
            const edge: Edge = { from, to, weight: 1 };
            edges.set(k, edge);
            dev.log("graph", "edge.created", `${from} → ${to}`, {
                from,
                to,
                weight: 1,
            });
        }
    }

    function getEdges(): Edge[] {
        return [...edges.values()];
    }

    function drainEdges(): Edge[] {
        const result = [...edges.values()];
        edges.clear();
        return result;
    }

    function recordUrl(source: string, url: string): void {
        const prev = urls.get(source);
        if (prev === url) return;
        urls.set(source, url);
        dev.log("graph", "url.updated", `${source} → ${url}`, {
            source,
            url,
        });
    }

    function getUrls(): Record<string, string> {
        return Object.fromEntries(urls);
    }

    return { recordEdge, getEdges, drainEdges, recordUrl, getUrls };
}
