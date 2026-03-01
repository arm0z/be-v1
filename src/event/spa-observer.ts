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
 * Returns a teardown function that restores the original methods.
 */
export function observeSpaNavigation(
    onNavigate: (url: string) => void,
): () => void {
    const origPush = history.pushState;
    const origReplace = history.replaceState;

    history.pushState = (...args) => {
        origPush.apply(history, args);
        onNavigate(window.location.href);
    };

    history.replaceState = (...args) => {
        origReplace.apply(history, args);
        onNavigate(window.location.href);
    };

    const popHandler = () => onNavigate(window.location.href);
    window.addEventListener("popstate", popHandler);

    return () => {
        history.pushState = origPush;
        history.replaceState = origReplace;
        window.removeEventListener("popstate", popHandler);
    };
}
