import { dev } from "./dev.ts";

/**
 * Visibility tracking — runs in every content script.
 *
 * Uses three signals to determine whether the user is looking at this tab:
 *   1. visibilitychange — tab shown/hidden (tab switch, minimize)
 *   2. window focus      — browser window gains OS-level focus
 *   3. window blur       — browser window loses OS-level focus
 *
 * visibilitychange alone is NOT enough: switching between two Chrome
 * windows that are both on-screen (e.g. different monitors) does not
 * fire visibilitychange because both tabs remain "visible".
 * focus/blur catches these window-to-window and alt-tab transitions.
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

/** Attach visibility listeners. Call once from the content script entry point. */
export function setupVisibility(): void {
    document.addEventListener("visibilitychange", () => {
        send(document.visibilityState === "visible");
    });

    window.addEventListener("focus", () => {
        send(true);
    });

    window.addEventListener("blur", () => {
        send(false);
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
