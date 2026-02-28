import type { StampedCapture, StampedSignal, Bundle } from "./types.ts";
import { UNKNOWN } from "./types.ts";
import { translate } from "./translate.ts";
import { dev } from "../event/dev.ts";
import type { createGraph } from "./graph.ts";

export function createBundler(graph: ReturnType<typeof createGraph>) {
    let activeSource: string | null = null;
    let openBundle: Bundle | null = null;
    const sealed: Bundle[] = [];

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

    function transition(to: string): void {
        seal();
        const from = activeSource;
        if (from) {
            graph.recordEdge(from, to);
        }
        dev.log("aggregator", "transition", `${from ?? "∅"} → ${to}`, { from, to });
        activeSource = to;
        if (to !== UNKNOWN) {
            openNew(to);
        }
    }

    function ingest(stamped: StampedCapture): void {
        if (activeSource === null || stamped.source !== activeSource) {
            transition(stamped.source);
        }
        openBundle!.captures.push(stamped);
    }

    function ingestSignal(stamped: StampedSignal): void {
        if (!openBundle) return; // no open bundle → silently drop
        openBundle.captures.push(stamped);
    }

    function getActiveSource(): string | null {
        return activeSource;
    }

    function getSealed(): Bundle[] {
        return [...sealed];
    }

    function drainSealed(): Bundle[] {
        const result = [...sealed];
        sealed.length = 0;
        return result;
    }

    return { ingest, ingestSignal, getActiveSource, seal, transition, getSealed, drainSealed };
}
