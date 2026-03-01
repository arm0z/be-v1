import type { Teardown } from "./types.ts";

/** Known SPA hosts where History API navigation is expected. */
const SPA_PATTERNS = [
    /outlook\.(com|live\.com)/,
    /mail\.google\.com/,
    /github\.com/,
];

/** Returns true if the URL belongs to a known SPA that uses History API navigation. */
export function needsSpaObserver(url: string): boolean {
    return SPA_PATTERNS.some((re) => re.test(url));
}

let patched = false;
let originalPush: History["pushState"] | null = null;
let originalReplace: History["replaceState"] | null = null;

/**
 * Monkey-patches history.pushState / replaceState and listens for popstate.
 * Calls `onNavigate` with the new URL on every SPA route change.
 * Returns a Teardown that restores the original methods.
 * Guards against double-patching — only the first call patches; subsequent
 * calls just update the callback and return a no-op teardown.
 */
export function observeSpaNavigation(
    onNavigate: (url: string) => void,
): Teardown {
    const ac = new AbortController();

    window.addEventListener("popstate", () => onNavigate(window.location.href), {
        signal: ac.signal,
    });

    if (patched) {
        return () => ac.abort();
    }

    originalPush = history.pushState.bind(history);
    originalReplace = history.replaceState.bind(history);
    patched = true;

    history.pushState = (...args) => {
        originalPush!(...args);
        onNavigate(window.location.href);
    };

    history.replaceState = (...args) => {
        originalReplace!(...args);
        onNavigate(window.location.href);
    };

    return () => {
        ac.abort();
        if (originalPush) history.pushState = originalPush;
        if (originalReplace) history.replaceState = originalReplace;
        originalPush = null;
        originalReplace = null;
        patched = false;
    };
}
