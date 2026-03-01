import type { DevChannel, DevEntry } from "@/event/dev";
import { useEffect, useRef, useState } from "react";

export type DevFilter = {
    channels: Record<DevChannel, boolean>;
    events: Record<string, boolean>;
};

type DevMessage =
    | { type: "entry"; entry: DevEntry }
    | { type: "filter"; filter: DevFilter };

const MAX_ENTRIES = 500;
const RECONNECT_MS = 1_000;

/**
 * Connects to the DevHub in the service worker via chrome.runtime.connect.
 * Automatically reconnects when the service worker restarts.
 * Returns live log entries and filter state with mutation helpers.
 */
export function useDevPort() {
    const [entries, setEntries] = useState<DevEntry[]>([]);
    const [filter, setFilter] = useState<DevFilter | null>(null);
    const portRef = useRef<chrome.runtime.Port | null>(null);

    useEffect(() => {
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;

        function connect() {
            if (disposed) return;

            const port = chrome.runtime.connect({ name: "dev" });
            portRef.current = port;

            port.onMessage.addListener((msg: DevMessage) => {
                if (msg.type === "entry") {
                    setEntries((prev) => {
                        const next = [...prev, msg.entry];
                        return next.length > MAX_ENTRIES
                            ? next.slice(-MAX_ENTRIES)
                            : next;
                    });
                }
                if (msg.type === "filter") {
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
            portRef.current?.disconnect();
            portRef.current = null;
        };
    }, []);

    function setChannelFilter(channels: Partial<Record<DevChannel, boolean>>) {
        portRef.current?.postMessage({ type: "setChannelFilter", channels });
    }

    function setEventFilter(events: Partial<Record<string, boolean>>) {
        portRef.current?.postMessage({ type: "setEventFilter", events });
    }

    function clear() {
        setEntries([]);
    }

    return { entries, filter, setChannelFilter, setEventFilter, clear };
}
