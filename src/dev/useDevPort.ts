import type { DevChannel, DevEntry, DevFilter } from "@/event/dev";
import { useEffect, useRef, useState } from "react";

export type { DevFilter };

type DevMessage =
    | { type: "entry"; entry: DevEntry }
    | { type: "replay"; entries: DevEntry[] }
    | { type: "filter"; filter: DevFilter };

const MAX_ENTRIES = 500;
const RECONNECT_MS = 1_000;

/**
 * Connects to the DevHub in the service worker via chrome.runtime.connect.
 * Automatically reconnects when the service worker restarts.
 * Returns live log entries and filter state with mutation helpers.
 *
 * Incoming entries are batched: individual "entry" messages accumulate in
 * a pending buffer and flush once per microtask, avoiding O(n) array copies
 * on every message.
 */
export function useDevPort() {
    const [entries, setEntries] = useState<DevEntry[]>([]);
    const [filter, setFilter] = useState<DevFilter | null>(null);
    const portRef = useRef<chrome.runtime.Port | null>(null);

    useEffect(() => {
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;

        // Batch incoming entries: accumulate during a microtask, flush once.
        let pending: DevEntry[] = [];
        let flushScheduled = false;

        function scheduleBatchFlush() {
            if (flushScheduled) return;
            flushScheduled = true;
            queueMicrotask(() => {
                flushScheduled = false;
                if (pending.length === 0) return;
                const batch = pending;
                pending = [];
                setEntries((prev) => {
                    const next =
                        prev.length + batch.length <= MAX_ENTRIES
                            ? [...prev, ...batch]
                            : [...prev, ...batch].slice(-MAX_ENTRIES);
                    return next;
                });
            });
        }

        function connect() {
            if (disposed) return;

            const port = chrome.runtime.connect({ name: "dev" });
            portRef.current = port;

            port.onMessage.addListener((msg: DevMessage) => {
                if (msg.type === "replay") {
                    // Bulk replay on connect — single state update
                    const bulk = msg.entries;
                    setEntries(
                        bulk.length > MAX_ENTRIES
                            ? bulk.slice(-MAX_ENTRIES)
                            : bulk,
                    );
                } else if (msg.type === "entry") {
                    pending.push(msg.entry);
                    scheduleBatchFlush();
                } else if (msg.type === "filter") {
                    setFilter(msg.filter);
                }
            });

            port.onDisconnect.addListener(() => {
                portRef.current = null;
                // service worker died — reconnect after a short delay
                if (!disposed) {
                    timer = setTimeout(connect, RECONNECT_MS);
                }
            });
        }

        connect();

        return () => {
            disposed = true;
            clearTimeout(timer);
            pending = [];
            portRef.current?.disconnect();
            portRef.current = null;
        };
    }, []);

    function setChannelFilter(channels: Partial<Record<DevChannel, boolean>>) {
        setFilter((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                channels: { ...prev.channels, ...channels },
            };
        });
        portRef.current?.postMessage({ type: "setChannelFilter", channels });
    }

    function setEventFilter(events: Partial<Record<string, boolean>>) {
        setFilter((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                events: { ...prev.events, ...events },
            };
        });
        portRef.current?.postMessage({ type: "setEventFilter", events });
    }

    function clear() {
        setEntries([]);
    }

    return { entries, filter, setChannelFilter, setEventFilter, clear };
}
