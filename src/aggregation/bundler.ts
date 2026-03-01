import type { StampedCapture, StampedSignal, Bundle } from "./types.ts";
import { UNKNOWN, OFF_BROWSER } from "./types.ts";
import { translate } from "./translate.ts";
import { dev } from "../event/dev.ts";
import type { createGraph } from "./graph.ts";

const DWELL_MS = 500;

export function createBundler(graph: ReturnType<typeof createGraph>) {
    let activeSource: string | null = null;
    let graphCursor: string | null = null;
    let openBundle: Bundle | null = null;
    const sealed: Bundle[] = [];
    let pendingEdge: { from: string; to: string; arrivedAt: number } | null = null;
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;

    function openNew(source: string): void {
        openBundle = {
            source,
            startedAt: Date.now(),
            endedAt: null,
            captures: [],
            text: null,
        };
        dev.log("aggregator", "bundle.opened", `bundle opened for ${source}`, { source });
    }

    function seal(): void {
        if (!openBundle) return;
        openBundle.endedAt = Date.now();
        openBundle.text = translate(openBundle);
        sealed.push(openBundle);
        dev.log("aggregator", "bundle.sealed", `bundle sealed for ${openBundle.source} (${openBundle.captures.length} captures)`, {
            source: openBundle.source,
            captures: openBundle.captures.length,
            text: openBundle.text,
        });
        openBundle = null;
    }

    function commitPending(): void {
        if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
        if (pendingEdge) {
            graph.recordEdge(pendingEdge.from, pendingEdge.to);
            pendingEdge = null;
        }
    }

    function transition(to: string): void {
        seal();
        if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
        const now = Date.now();

        if (pendingEdge) {
            const elapsed = now - pendingEdge.arrivedAt;
            if (elapsed >= DWELL_MS) {
                // Destination was held long enough — commit
                graph.recordEdge(pendingEdge.from, pendingEdge.to);
                if (pendingEdge.to !== to) {
                    pendingEdge = { from: pendingEdge.to, to, arrivedAt: now };
                } else {
                    pendingEdge = null;
                }
            } else {
                // Too brief — collapse the intermediate node
                // A → X(brief) → B  becomes  A → B
                if (pendingEdge.from !== to) {
                    pendingEdge = { from: pendingEdge.from, to, arrivedAt: now };
                } else {
                    // Returned to origin — cancel entirely
                    pendingEdge = null;
                }
            }
        } else {
            const from = graphCursor;
            if (from && from !== to) {
                pendingEdge = { from, to, arrivedAt: now };
            }
        }

        // Auto-commit after dwell threshold if user stays
        if (pendingEdge) {
            dwellTimer = setTimeout(commitPending, DWELL_MS);
        }

        dev.log("aggregator", "transition", `${graphCursor ?? "∅"} → ${to}`, { from: graphCursor, to });
        graphCursor = to;
        activeSource = to;
        if (to !== UNKNOWN && to !== OFF_BROWSER) {
            openNew(to);
        }
    }

    function moveCursor(to: string): void {
        graphCursor = to;
    }

    function getGraphCursor(): string | null {
        return graphCursor;
    }

    function ingest(stamped: StampedCapture): void {
        if (activeSource === null || stamped.source !== activeSource) {
            transition(stamped.source);
        } else if (!openBundle) {
            openNew(stamped.source);
        }
        openBundle!.captures.push(stamped);
    }

    function ingestSignal(stamped: StampedSignal): void {
        if (!openBundle) {
            if (activeSource && activeSource !== UNKNOWN && activeSource !== OFF_BROWSER) {
                openNew(activeSource);
            } else {
                return;
            }
        }
        openBundle.captures.push(stamped);
    }

    function getActiveSource(): string | null {
        return activeSource;
    }

    function getOpenBundle(): { source: string; startedAt: number; captureCount: number; captures: { type: string; timestamp: number }[] } | null {
        if (!openBundle) return null;
        return {
            source: openBundle.source,
            startedAt: openBundle.startedAt,
            captureCount: openBundle.captures.length,
            captures: openBundle.captures.map((c) => ({ type: c.type, timestamp: c.timestamp })),
        };
    }

    function getSealed(): Bundle[] {
        return [...sealed];
    }

    function drainSealed(): Bundle[] {
        const result = [...sealed];
        sealed.length = 0;
        return result;
    }

    return { ingest, ingestSignal, getActiveSource, getGraphCursor, getOpenBundle, seal, transition, moveCursor, getSealed, drainSealed, commitPending };
}
