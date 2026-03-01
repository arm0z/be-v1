import type { Capture, Signal } from "../event/types.ts";

export const UNKNOWN = "unknown" as const;
export const OFF_BROWSER = "off_browser" as const;

export type StampedCapture = Capture & { tabId: string; source: string };
export type StampedSignal = Signal & { tabId: string; source: string };
export type BundleEntry = StampedCapture | StampedSignal;

export type Bundle = {
    source: string;
    startedAt: number;
    endedAt: number | null;
    captures: BundleEntry[];
    text: string | null;
};

export type Edge = {
    from: string;
    to: string;
    weight: number;
};

export type Aggregator = {
    ingest(capture: Capture, tabId: string): void;
    ingestSignal(signal: Signal, tabId: string): void;
    onTabActivated(tabId: string, windowId: number): void;
    onWindowFocusChanged(windowId: number): void;
    getSealed(): Bundle[];
    getEdges(): Edge[];
    drainSealed(): Bundle[];
    drainEdges(): Edge[];
};
