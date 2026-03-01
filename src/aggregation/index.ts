import type { Capture, Signal } from "../event/types.ts";
import { OFF_BROWSER } from "./types.ts";

import type { Aggregator } from "./types.ts";
import { createBundler } from "./bundler.ts";
import { createGraph } from "./graph.ts";
import { dev } from "../event/dev.ts";

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
    const tabSources = new Map<string, string>();
    const pendingSignals = new Map<
        string,
        { signal: Signal; tabId: string }[]
    >();
    const activeTabPerWindow = new Map<number, string>();
    let offBrowserTimer: ReturnType<typeof setTimeout> | null = null;
    const OFF_BROWSER_SETTLE_MS = 200;

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
            edges: graph.getEdges(),
            urls: graph.getUrls(),
        });
    }

    function flushPending(tabId: string, source: string): void {
        const pending = pendingSignals.get(tabId);
        if (!pending) return;
        pendingSignals.delete(tabId);
        for (const p of pending) {
            const stamped = { ...p.signal, tabId: p.tabId, source };
            bundler.ingestSignal(stamped);
            const url = signalPageUrl(p.signal);
            if (url) graph.recordUrl(source, url);
        }
    }

    function ingest(capture: Capture, tabId: string): void {
        const source = `${capture.context}@${tabId}`;
        tabSources.set(tabId, source);
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

        dev.log("aggregator", signal.type, source, {
            tabId,
            source,
            payload: signal.payload,
        });
        const stamped = { ...signal, tabId, source };
        bundler.ingestSignal(stamped);

        const url = signalPageUrl(signal);
        if (url) graph.recordUrl(source, url);

        if (signal.type === "tab.closed") {
            tabSources.delete(tabId);
            pendingSignals.delete(tabId);
            for (const [windowId, activeTabId] of activeTabPerWindow.entries()) {
                if (activeTabId === tabId) {
                    activeTabPerWindow.delete(windowId);
                }
            }
        }
        emitState();
    }

    function cancelOffBrowser(): void {
        if (offBrowserTimer !== null) {
            clearTimeout(offBrowserTimer);
            offBrowserTimer = null;
            dev.log("navigation", "off_browser.cancel", "off-browser timer cancelled — user returned to Chrome");
        }
    }

    function startOffBrowserTimer(): void {
        cancelOffBrowser();
        bundler.seal();
        dev.log("navigation", "off_browser.start", `off-browser timer started (${OFF_BROWSER_SETTLE_MS}ms settle)`);
        offBrowserTimer = setTimeout(() => {
            offBrowserTimer = null;
            dev.log("navigation", "off_browser.commit", "off-browser timer fired — transitioning to off_browser");
            bundler.transition(OFF_BROWSER);
            emitState();
        }, OFF_BROWSER_SETTLE_MS);
    }

    function onTabActivated(tabId: string, windowId: number): void {
        const prevTabId = activeTabPerWindow.get(windowId);
        activeTabPerWindow.set(windowId, tabId);

        if (offBrowserTimer !== null) {
            if (prevTabId === tabId) {
                dev.log("navigation", "tab.spurious", `ignoring spurious activation for same tab ${tabId} during off-browser settle`, {
                    tabId, windowId,
                });
                return;
            }
            dev.log("navigation", "tab.override_settle", `new tab ${tabId} activated during off-browser settle — cancelling timer`, {
                tabId, prevTabId, windowId,
            });
            cancelOffBrowser();
        }

        let source = tabSources.get(tabId);
        const isNew = !source;
        if (!source) {
            source = `root@${tabId}`;
            tabSources.set(tabId, source);
        }
        dev.log("navigation", "tab.resolved", `tab ${tabId} → source ${source}${isNew ? " (new)" : ""}`, {
            tabId, windowId, source, prevTabId, isNew,
        });
        bundler.transition(source);
        emitState();
    }

    function onWindowFocusChanged(windowId: number): void {
        if (windowId === chrome.windows.WINDOW_ID_NONE) {
            startOffBrowserTimer();
        } else {
            cancelOffBrowser();
            const tabId = activeTabPerWindow.get(windowId);
            if (tabId) {
                let source = tabSources.get(tabId);
                const isNew = !source;
                if (!source) {
                    source = `root@${tabId}`;
                    tabSources.set(tabId, source);
                }
                dev.log("navigation", "window.resolved", `window ${windowId} → tab ${tabId} → source ${source}${isNew ? " (new)" : ""}`, {
                    windowId, tabId, source, isNew,
                });
                bundler.transition(source);
            } else {
                dev.log("navigation", "window.no_tab", `window ${windowId} has no active tab (DevTools / popup)`, {
                    windowId,
                });
            }
        }
        emitState();
    }

    function onWindowRemoved(windowId: number): void {
        activeTabPerWindow.delete(windowId);
    }

    return {
        ingest,
        ingestSignal,
        onTabActivated,
        onWindowFocusChanged,
        onWindowRemoved,
        getSealed: bundler.getSealed,
        getEdges: graph.getEdges,
        drainSealed: bundler.drainSealed,
        drainEdges: () => { bundler.commitPending(); return graph.drainEdges(); },
    };
}
