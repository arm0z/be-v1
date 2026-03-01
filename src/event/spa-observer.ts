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

/**
 * Monkey-patches history.pushState / replaceState and listens for popstate.
 * Calls `onNavigate` with the new URL on every SPA route change.
 */
export function observeSpaNavigation(onNavigate: (url: string) => void): void {
    const originalPush = history.pushState.bind(history);
    history.pushState = (...args) => {
        originalPush(...args);
        onNavigate(window.location.href);
    };

    const originalReplace = history.replaceState.bind(history);
    history.replaceState = (...args) => {
        originalReplace(...args);
        onNavigate(window.location.href);
    };

    window.addEventListener("popstate", () => onNavigate(window.location.href));
}
