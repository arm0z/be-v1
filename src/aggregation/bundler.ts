import type {
    Bundle,
    Checkpoint,
    StampedCapture,
    StampedSignal,
    Transition,
} from "./types.ts";
import { OFF_BROWSER, UNKNOWN } from "./types.ts";

import { dev } from "../event/dev.ts";
import { translate } from "./translate.ts";

const DWELL_MS = 1_000;

export function createBundler() {
    let activeSource: string | null = null;
    let openBundle: Bundle | null = null;
    const sealed: Bundle[] = [];
    const transitions: Transition[] = [];

    // ── dwell mechanism ────────────────────────────────────────
    // Holds an edge for DWELL_MS before committing. If the target
    // source transitions away within the window, the edge collapses
    // (A→B→C becomes A→C), preventing brief intermediates like
    // off_browser from appearing in the graph.

    let pendingEdge: Transition | null = null;
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;

    function commitPending(): void {
        if (!pendingEdge) return;
        transitions.push(pendingEdge);
        dev.log(
            "aggregator",
            "edge.committed",
            `${pendingEdge.from} → ${pendingEdge.to}`,
            { from: pendingEdge.from, to: pendingEdge.to, dwellMs: pendingEdge.dwellMs },
        );
        pendingEdge = null;
        if (dwellTimer !== null) {
            clearTimeout(dwellTimer);
            dwellTimer = null;
        }
    }

    function startDwellTimer(): void {
        if (dwellTimer !== null) clearTimeout(dwellTimer);
        dwellTimer = setTimeout(() => {
            dwellTimer = null;
            commitPending();
        }, DWELL_MS);
    }

    // ── core operations ────────────────────────────────────────

    function openNew(source: string): void {
        openBundle = {
            source,
            startedAt: Date.now(),
            endedAt: null,
            captures: [],
            text: null,
        };
        dev.log("aggregator", "bundle.opened", `bundle opened for ${source}`, {
            source,
        });
    }

    function seal(): void {
        if (!openBundle) return;
        openBundle.endedAt = Date.now();
        openBundle.text = translate(openBundle);
        sealed.push(openBundle);
        dev.log(
            "aggregator",
            "bundle.sealed",
            `bundle sealed for ${openBundle.source} (${openBundle.captures.length} captures)`,
            {
                source: openBundle.source,
                captures: openBundle.captures.length,
                text: openBundle.text,
            },
        );
        openBundle = null;
        sealCb?.();
    }

    function transition(to: string): void {
        const from = activeSource;
        seal();

        if (from) {
            const lastSealed = sealed[sealed.length - 1];
            const dwellMs = lastSealed
                ? lastSealed.endedAt! - lastSealed.startedAt
                : 0;

            if (pendingEdge && dwellMs < DWELL_MS) {
                // Intermediate source dwelled briefly → collapse
                if (dwellTimer !== null) {
                    clearTimeout(dwellTimer);
                    dwellTimer = null;
                }
                dev.log(
                    "aggregator",
                    "edge.collapsed",
                    `${pendingEdge.from} → ${from} → ${to} collapsed to ${pendingEdge.from} → ${to}`,
                    {
                        original: { from: pendingEdge.from, to: from },
                        collapsed: { from: pendingEdge.from, to },
                        intermediateDwellMs: dwellMs,
                    },
                );

                if (pendingEdge.from === to) {
                    // Self-loop after collapse (e.g. A → off_browser → A) — drop
                    pendingEdge = null;
                } else {
                    pendingEdge = {
                        from: pendingEdge.from,
                        to,
                        ts: Date.now(),
                        dwellMs: pendingEdge.dwellMs,
                    };
                    startDwellTimer();
                }
            } else {
                // Commit previous pending (if any), start new pending
                commitPending();
                pendingEdge = { from, to, ts: Date.now(), dwellMs };
                startDwellTimer();
            }
        }

        dev.log("aggregator", "transition", `${from ?? "∅"} → ${to}`, {
            from,
            to,
        });
        activeSource = to;
        if (to !== UNKNOWN && to !== OFF_BROWSER) {
            openNew(to);
        }
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
            if (
                activeSource &&
                activeSource !== UNKNOWN &&
                activeSource !== OFF_BROWSER
            ) {
                openNew(activeSource);
            } else {
                return;
            }
        }
        openBundle!.captures.push(stamped);
    }

    function getActiveSource(): string | null {
        return activeSource;
    }

    function getOpenBundle(): {
        source: string;
        startedAt: number;
        captureCount: number;
        captures: { type: string; timestamp: number }[];
    } | null {
        if (!openBundle) return null;
        return {
            source: openBundle.source,
            startedAt: openBundle.startedAt,
            captureCount: openBundle.captures.length,
            captures: openBundle.captures.map((c) => ({
                type: c.type,
                timestamp: c.timestamp,
            })),
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

    function getTransitions(): Transition[] {
        if (pendingEdge) return [...transitions, pendingEdge];
        return [...transitions];
    }

    function drainTransitions(): Transition[] {
        commitPending();
        const result = [...transitions];
        transitions.length = 0;
        return result;
    }

    let sealCb: (() => void) | null = null;

    function onSeal(cb: () => void): void {
        sealCb = cb;
    }

    function snapshot(): Checkpoint {
        commitPending();
        return {
            activeSource,
            openBundle: openBundle
                ? {
                      ...openBundle,
                      captures: [...openBundle.captures],
                  }
                : null,
            sealed: sealed.map((b) => ({ ...b, captures: [...b.captures] })),
            transitions: [...transitions],
            savedAt: Date.now(),
        };
    }

    function restore(cp: Checkpoint): void {
        activeSource = cp.activeSource;

        for (const b of cp.sealed) {
            sealed.push(b);
        }
        for (const t of cp.transitions) {
            transitions.push(t);
        }

        if (cp.openBundle) {
            const stale = cp.openBundle;
            const lastCapture = stale.captures[stale.captures.length - 1];
            stale.endedAt = lastCapture?.timestamp ?? cp.savedAt;
            stale.text = translate(stale);
            sealed.push(stale);
        }
        // Don't reopen a bundle — the next ingest will do that naturally.
    }

    return {
        ingest,
        ingestSignal,
        getActiveSource,
        getOpenBundle,
        seal,
        transition,
        getSealed,
        drainSealed,
        getTransitions,
        drainTransitions,
        snapshot,
        restore,
        onSeal,
    };
}
