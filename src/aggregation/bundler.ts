import type {
    Bundle,
    StampedCapture,
    StampedSignal,
    Transition,
} from "./types.ts";
import { OFF_BROWSER, UNKNOWN } from "./types.ts";

import { dev } from "../event/dev.ts";
import { translate } from "./translate.ts";

export function createBundler() {
    let activeSource: string | null = null;
    let openBundle: Bundle | null = null;
    const sealed: Bundle[] = [];
    const transitions: Transition[] = [];

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
    }

    function transition(to: string): void {
        const from = activeSource;
        seal();
        if (from) {
            const lastSealed = sealed[sealed.length - 1];
            const dwellMs = lastSealed
                ? lastSealed.endedAt! - lastSealed.startedAt
                : 0;
            transitions.push({ from, to, ts: Date.now(), dwellMs });
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
        return [...transitions];
    }

    function drainTransitions(): Transition[] {
        const result = [...transitions];
        transitions.length = 0;
        return result;
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
    };
}
