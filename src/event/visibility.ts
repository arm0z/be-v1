import { dev } from "./dev.ts";

/**
 * Page Visibility API tracking — runs in every content script.
 *
 * Reports whether the page is *rendered on screen* (the tab is the
 * foreground tab in a non-minimized window). This is true even when
 * the window does NOT have OS-level focus, so multiple tabs across
 * monitors can be "visible" simultaneously.
 *
 * "Active" (selected tab in the focused window) is tracked separately
 * by the service worker via chrome.tabs / chrome.windows APIs.
 */

let lastState: boolean | null = null;

function send(visible: boolean): void {
    if (lastState === visible) return;
    lastState = visible;

    dev.log(
        "tap",
        "attention.visible",
        visible ? "page became visible" : "page became hidden",
        { visible, url: window.location.href, title: document.title },
    );

    chrome.runtime
        .sendMessage({
            type: "page:visibility",
            visible,
            url: window.location.href,
            title: document.title,
        })
        .catch(() => {
            // Service worker might not be ready yet
        });
}

/** Attach Page Visibility API listeners. Call once from the content script entry point. */
export function setupVisibility(): void {
    document.addEventListener("visibilitychange", () => {
        send(document.visibilityState === "visible");
    });

    // Re-send state when page is restored from bfcache (content script
    // doesn't re-run, but the message channel is re-established)
    window.addEventListener("pageshow", (e) => {
        if (e.persisted) {
            lastState = null; // force re-send
            send(document.visibilityState === "visible");
        }
    });

    // Report initial state when the content script loads
    send(document.visibilityState === "visible");
}
