import type { Relay as RelayFn, Teardown } from "./types.ts";
import { dev } from "./dev.ts";

const RECONNECT_BASE_MS = 100;
const RECONNECT_MAX_MS = 5_000;
const STABLE_THRESHOLD_MS = 5_000;

/** Terminal layer. Wraps a Tap and forwards every Capture to the service worker via a persistent port. Reconnects automatically when the service worker terminates. */
export const relay: RelayFn = (inner) => {
    let port: chrome.runtime.Port | null = null;
    let innerTeardown: Teardown | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = RECONNECT_BASE_MS;
    let disposed = false;

    function teardownInner() {
        if (innerTeardown) { innerTeardown(); innerTeardown = null; }
        if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    }

    function connect() {
        if (disposed) return;

        try {
            port = chrome.runtime.connect({ name: "capture" });
        } catch {
            dev.log("relay", "lifecycle", "connect failed — extension context invalidated");
            return;
        }

        port.onDisconnect.addListener(() => {
            port = null;
            teardownInner();
            if (disposed) return;
            dev.log("relay", "lifecycle", `port disconnected, reconnecting in ${backoffMs}ms`);
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, backoffMs);
            backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
        });

        const currentPort = port;
        innerTeardown = inner((capture) => {
            dev.log("relay", capture.type, `relay → sw: ${capture.type}`, capture.payload);
            try {
                currentPort.postMessage({ type: "capture", payload: capture });
            } catch { /* disconnect handler will fire */ }
        });

        stableTimer = setTimeout(() => {
            backoffMs = RECONNECT_BASE_MS;
            stableTimer = null;
        }, STABLE_THRESHOLD_MS);

        dev.log("relay", "lifecycle", "port connected");
    }

    connect();

    return () => {
        disposed = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        teardownInner();
        if (port) { port.disconnect(); port = null; }
    };
};
