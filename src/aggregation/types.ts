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

/** Raw transition record. Logged by the bundler on every source change. */
export type Transition = {
    from: string;
    to: string;
    ts: number;
    dwellMs: number;
};

export type DirectedGraph = {
    nodes: Set<string>;
    /** Key: "from\0to", value: aggregated weight (transition count). */
    edges: Map<string, number>;
    inDegree: Map<string, number>;
    outDegree: Map<string, number>;
    totalWeight: number;
};

export type LouvainResult = {
    /** source (or chunk ID) → community ID */
    communities: Map<string, string>;
    modularity: number;
};

export type ChunkInfo = {
    originalSource: string;
    chunkIndex: number;
    windowStartMs: number;
    /** Dynamic window size computed for this hub. */
    chunkWindowMs: number;
};

export type PreprocessResult = {
    transitions: Transition[];
    excludedSources: Set<string>;
    sentinelCount: number;
    /** hub chunk ID → chunk metadata */
    chunkMap: Map<string, ChunkInfo>;
    hubSources: Set<string>;
};

export type GroupMeta = {
    sources: string[];
    tabs: string[];
    timeRange: { start: number; end: number };
};

export type Group = {
    id: string;
    bundles: Bundle[];
    text: string;
    meta: GroupMeta;
};

export type Packet = {
    id: string;
    groups: Group[];
    edges: Edge[];
    createdAt: number;
};

export type Aggregator = {
    ingest(capture: Capture, tabId: string): void;
    ingestSignal(signal: Signal, tabId: string): void;

    /** Set the currently active tab, or null for off-browser. */
    setActiveTab(tabId: string | null, url?: string): void;

    getSealed(): Bundle[];
    drainSealed(): Bundle[];

    /** Non-destructive read of the raw transition log. */
    getTransitions(): Transition[];
    /** Destructive read — returns all transitions and clears the log. */
    drainTransitions(): Transition[];

    /** Seal the current open bundle (if any). Used by the packer before draining. */
    seal(): void;

    /** Snapshot all in-memory state for checkpointing. */
    snapshot(): Checkpoint;
    /** Restore state from a checkpoint. */
    restore(cp: Checkpoint): void;
    /** Register a callback that fires after every bundle seal. */
    onSeal(cb: () => void): void;
};

export type Checkpoint = {
    activeSource: string | null;
    openBundle: Bundle | null;
    sealed: Bundle[];
    transitions: Transition[];
    savedAt: number;
};
