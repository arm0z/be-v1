import type { Relay as RelayFn } from "./types.ts";
import { dev } from "./dev.ts";

/** Terminal layer. Wraps a Tap and forwards every Capture to the service worker. */
export const relay: RelayFn = (inner) => {
	const teardown = inner((capture) => {
		dev.log("relay", capture.type, "relay → sw", capture);
		chrome.runtime.sendMessage({ type: "capture", payload: capture });
	});

	return teardown;
};
