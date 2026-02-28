import type { Aggregator } from "./types.ts";
import type { Capture, Signal } from "../event/types.ts";
import { UNKNOWN } from "./types.ts";
import { createBundler } from "./bundler.ts";
import { createGraph } from "./graph.ts";

function signalPageUrl(signal: Signal): string | undefined {
    switch (signal.type) {
        case "nav.completed":
        case "nav.spa":
        case "nav.title_changed":
        case "tab.created":
        case "attention.active":
        case "attention.visible":
            return signal.payload.url || undefined;
        default:
            return undefined;
    }
}

export function createAggregator(): Aggregator {
    const graph = createGraph();
    const bundler = createBundler(graph);

    function ingest(capture: Capture, tabId: string): void {
        const source = `${capture.context}@${tabId}`;
        const stamped = { ...capture, tabId, source };
        bundler.ingest(stamped);
    }

    function ingestSignal(signal: Signal, tabId: string): void {
        const source = bundler.getActiveSource() ?? UNKNOWN;
        const stamped = { ...signal, tabId, source };
        bundler.ingestSignal(stamped);

        const url = signalPageUrl(signal);
        if (url && source !== UNKNOWN) graph.recordUrl(source, url);
    }

    function onTabActivated(): void {
        bundler.seal();
    }

    function onWindowFocusChanged(windowId: number): void {
        if (windowId === chrome.windows.WINDOW_ID_NONE) {
            bundler.transition(UNKNOWN);
        } else {
            bundler.seal();
        }
    }

    return {
        ingest,
        ingestSignal,
        onTabActivated,
        onWindowFocusChanged,
        getSealed: bundler.getSealed,
        getEdges: graph.getEdges,
        drainSealed: bundler.drainSealed,
        drainEdges: graph.drainEdges,
    };
}
