import type { Capture, Signal } from "../event/types.ts";

import type { Aggregator } from "./types.ts";
import { OFF_BROWSER } from "./types.ts";
import { createBundler } from "./bundler.ts";
import { dev } from "../event/dev.ts";

export function createAggregator(): Aggregator {
    const bundler = createBundler();
    const tabSources = new Map<string, string>();
    const sourceUrls = new Map<string, string>();
    const pendingSignals = new Map<
        string,
        { signal: Signal; tabId: string }[]
    >();

    function emitState() {
        dev.log("aggregator", "state.snapshot", "state", {
            activeSource: bundler.getActiveSource(),
            openBundle: bundler.getOpenBundle(),
            sealedBundles: bundler.getSealed().map((b) => ({
                source: b.source,
                startedAt: b.startedAt,
                endedAt: b.endedAt,
                captureCount: b.captures.length,
                text: b.text,
                captures: b.captures.map((c) => ({
                    type: c.type,
                    timestamp: c.timestamp,
                })),
            })),
            transitions: bundler.getTransitions(),
            sourceUrls: Object.fromEntries(sourceUrls),
        });
    }

    function flushPending(tabId: string, source: string): void {
        const pending = pendingSignals.get(tabId);
        if (!pending) return;
        pendingSignals.delete(tabId);
        for (const p of pending) {
            const stamped = { ...p.signal, tabId: p.tabId, source };
            bundler.ingestSignal(stamped);
        }
    }

    function resolveSource(tabId: string, url?: string): string {
        const captured = tabSources.get(tabId);
        if (captured) return captured;
        if (url) {
            try {
                return `${new URL(url).hostname}@${tabId}`;
            } catch {
                // invalid URL, fall through
            }
        }
        return `root@${tabId}`;
    }

    function ingest(capture: Capture, tabId: string): void {
        const source = `${capture.context}@${tabId}`;
        tabSources.set(tabId, source);
        if (capture.type === "html.content") {
            sourceUrls.set(source, capture.payload.url);
        }
        dev.log("aggregator", capture.type, source, {
            tabId,
            source,
            payload: capture.payload,
        });
        const stamped = { ...capture, tabId, source };
        bundler.ingest(stamped);
        flushPending(tabId, source);
        emitState();
    }

    function ingestSignal(signal: Signal, tabId: string): void {
        if (tabId === "unknown") {
            const currentSource = bundler.getActiveSource();
            if (currentSource) {
                const stamped = { ...signal, tabId, source: currentSource };
                bundler.ingestSignal(stamped);
                emitState();
            }
            return;
        }

        const source = tabSources.get(tabId);

        if (!source) {
            let pending = pendingSignals.get(tabId);
            if (!pending) {
                pending = [];
                pendingSignals.set(tabId, pending);
            }
            pending.push({ signal, tabId });
            dev.log("aggregator", signal.type, "pending", {
                tabId,
                payload: signal.payload,
            });

            if (signal.type === "tab.closed") {
                pendingSignals.delete(tabId);
            }
            return;
        }

        if (
            signal.type === "nav.completed" ||
            signal.type === "nav.spa" ||
            signal.type === "nav.title_changed"
        ) {
            sourceUrls.set(source, signal.payload.url);
        }
        dev.log("aggregator", signal.type, source, {
            tabId,
            source,
            payload: signal.payload,
        });
        const stamped = { ...signal, tabId, source };
        bundler.ingestSignal(stamped);

        if (signal.type === "tab.closed") {
            tabSources.delete(tabId);
            pendingSignals.delete(tabId);
        }
        emitState();
    }

    function setActiveTab(tabId: string | null, url?: string): void {
        if (tabId === null) {
            if (bundler.getActiveSource() === OFF_BROWSER) return;
            dev.log(
                "navigation",
                "off_browser",
                "transitioning to off_browser",
            );
            bundler.transition(OFF_BROWSER);
            emitState();
            return;
        }
        const source = resolveSource(tabId, url);
        if (source === bundler.getActiveSource()) return;
        dev.log(
            "navigation",
            "tab.visible",
            `tab ${tabId} visible → ${source}`,
            { tabId, source, url },
        );
        bundler.transition(source);
        emitState();
    }

    return {
        ingest,
        ingestSignal,
        setActiveTab,
        getSealed: bundler.getSealed,
        drainSealed: bundler.drainSealed,
        getTransitions: bundler.getTransitions,
        drainTransitions: bundler.drainTransitions,
        seal: bundler.seal,
        snapshot: bundler.snapshot,
        restore: bundler.restore,
        onSeal: bundler.onSeal,
    };
}
