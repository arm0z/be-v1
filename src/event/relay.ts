import type { Relay as RelayFn } from "./types.ts";
import { dev } from "./dev.ts";

/** Terminal layer. Wraps a Tap and forwards every Capture to the service worker via a persistent port. */
export const relay: RelayFn = (inner) => {
    const port = chrome.runtime.connect({ name: "capture" });
    let tornDown = false;

    function teardownInner(): void {
        if (tornDown) return;
        tornDown = true;
        tapTeardown();
    }

    port.onDisconnect.addListener(() => teardownInner());

    const tapTeardown = inner((capture) => {
        dev.log(
            "relay",
            capture.type,
            `relay → sw: ${capture.type}`,
            capture.payload,
        );
        try {
            port.postMessage({ type: "capture", payload: capture });
        } catch {
            teardownInner();
        }
    });

    return () => {
        teardownInner();
        port.disconnect();
    };
};
