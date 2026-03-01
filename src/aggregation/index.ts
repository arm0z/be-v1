import type { Capture, Signal } from "../event/types.ts";

import type { Aggregator } from "./types.ts";
import { OFF_BROWSER } from "./types.ts";
import { createBundler } from "./bundler.ts";
import { dev } from "../event/dev.ts";

export function createAggregator(): Aggregator {
    const bundler = createBundler();
    const tabSources = new Map<string, string>();
    const pendingSignals = new Map<
        string,
        { signal: Signal; tabId: string }[]
    >();
    let offBrowserTimer: ReturnType<typeof setTimeout> | null = null;
    const OFF_BROWSER_SETTLE_MS = 1000;

    let visibleTabId: string | null = null;
    let offBrowserCb: ((offBrowser: boolean) => void) | null = null;

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

    function resolveSource(tabId: string): string {
        return tabSources.get(tabId) ?? `root@${tabId}`;
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

        if (signal.type === "tab.closed") {
            tabSources.delete(tabId);
            pendingSignals.delete(tabId);
            if (visibleTabId === tabId) {
                visibleTabId = null;
                startOffBrowserTimer();
            }
        }
        emitState();
    }

    function startOffBrowserTimer(): void {
        if (offBrowserTimer !== null) clearTimeout(offBrowserTimer);
        dev.log(
            "navigation",
            "off_browser.start",
            `off-browser timer started (${OFF_BROWSER_SETTLE_MS}ms)`,
        );
        offBrowserTimer = setTimeout(() => {
            offBrowserTimer = null;
            dev.log(
                "navigation",
                "off_browser.commit",
                "transitioning to off_browser",
            );
            bundler.transition(OFF_BROWSER);
            offBrowserCb?.(true);
            emitState();
        }, OFF_BROWSER_SETTLE_MS);
    }

    function onVisibilityChanged(tabId: string, visible: boolean): void {
        if (visible) {
            const wasOffBrowser =
                offBrowserTimer !== null ||
                bundler.getActiveSource() === OFF_BROWSER;
            if (offBrowserTimer !== null) {
                clearTimeout(offBrowserTimer);
                offBrowserTimer = null;
                dev.log(
                    "navigation",
                    "off_browser.cancel",
                    "off-browser timer cancelled",
                );
            }
            if (wasOffBrowser) offBrowserCb?.(false);
            visibleTabId = tabId;
            const source = resolveSource(tabId);
            if (source === bundler.getActiveSource()) return;
            dev.log(
                "navigation",
                "tab.visible",
                `tab ${tabId} visible → ${source}`,
                { tabId, source },
            );
            bundler.transition(source);
            emitState();
        } else {
            if (tabId !== visibleTabId) return;
            visibleTabId = null;
            startOffBrowserTimer();
        }
    }

    return {
        ingest,
        ingestSignal,
        onVisibilityChanged,
        onOffBrowser(cb: (offBrowser: boolean) => void) {
            offBrowserCb = cb;
        },
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
