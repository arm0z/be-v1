export type DevChannel =
    | "tap"
    | "adapter"
    | "normalizer"
    | "relay"
    | "aggregator"
    | "packer"
    | "navigation"
    | "sync"
    | "checkpoint";

export type DevCaptureSummary = { type: string; timestamp: number };

export type DevStateSnapshot = {
    activeSource: string | null;
    openBundle: {
        source: string;
        startedAt: number;
        captureCount: number;
        captures: DevCaptureSummary[];
    } | null;
    sealedBundles: {
        source: string;
        startedAt: number;
        endedAt: number | null;
        captureCount: number;
        text: string | null;
        captures: DevCaptureSummary[];
    }[];
    transitions: { from: string; to: string; ts: number; dwellMs: number }[];
};

export type DevEntry = {
    channel: DevChannel;
    event?: string;
    timestamp: number;
    source?: string;
    message: string;
    data?: unknown;
};

export type DevFilter = {
    channels: Record<DevChannel, boolean>;
    events: Record<string, boolean>;
};

function createDevLog() {
    if (!import.meta.env.DEV) {
        return (
            _channel: DevChannel,
            _event: string,
            _message: string,
            _data?: unknown,
        ) => {};
    }

    return (
        channel: DevChannel,
        event: string,
        message: string,
        data?: unknown,
    ) => {
        const entry: DevEntry = {
            channel,
            event,
            timestamp: Date.now(),
            message,
            data,
        };
        chrome.runtime.sendMessage({ type: "dev:log", entry });
    };
}

export const dev = { log: createDevLog() };
