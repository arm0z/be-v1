import type { Adapter, HTMLContentPayload } from "../types.ts";
import { dev } from "../dev.ts";
import { extractDOM } from "../extract/dom.ts";

export const HTML_CONTENT = "html.content" as const;
export type { HTMLContentPayload };

// ── constants ────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;
const COOLDOWN_MS = 2_000;
const SETTLE_MS = 300;
const SCROLL_THRESHOLD = 0.5;
const SCROLL_IDLE_MS = 150;
const CONTENT_BUDGET = 65_536;
const MUTATION_TEXT_MIN = 50;

// ── adapter ──────────────────────────────────────────────────────────

/** Wraps any Tap and injects event-driven HTML snapshots (deduped by hash). */
export const htmlAdapter: Adapter = (inner) => {
    return (sink) => {
        const ac = new AbortController();
        const { signal } = ac;

        let lastHash: string | null = null;
        let lastSnapshotTime = 0;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
        let scrollAccum = 0;
        let lastScrollY = window.scrollY;
        let observer: MutationObserver | null = null;

        // ── core snapshot machinery ──────────────────────────────

        function takeSnapshot(trigger: HTMLContentPayload["trigger"]) {
            const now = Date.now();
            if (now - lastSnapshotTime < COOLDOWN_MS) {
                dev.log(
                    "adapter",
                    HTML_CONTENT,
                    "snapshot skipped (cooldown)",
                    { trigger },
                );
                return;
            }

            let html = document.documentElement.outerHTML;
            if (new Blob([html]).size > CONTENT_BUDGET) {
                html = html.slice(0, CONTENT_BUDGET);
            }

            const text = extractDOM();
            const hash = simpleHash(html);
            if (hash === lastHash) {
                dev.log(
                    "adapter",
                    HTML_CONTENT,
                    "snapshot skipped (same hash)",
                    { trigger },
                );
                return;
            }

            lastHash = hash;
            lastSnapshotTime = now;

            dev.log("adapter", HTML_CONTENT, "html snapshot", { trigger });
            sink({
                type: HTML_CONTENT,
                ts: now,
                context: "root",
                payload: {
                    trigger,
                    url: window.location.href,
                    title: document.title,
                    viewport: {
                        width: window.innerWidth,
                        height: window.innerHeight,
                        scrollY: window.scrollY,
                        scrollPercent:
                            document.documentElement.scrollHeight > 0
                                ? window.scrollY /
                                  document.documentElement.scrollHeight
                                : 0,
                    },
                    html,
                    text,
                } satisfies HTMLContentPayload,
            });
        }

        function scheduleSnapshot(trigger: HTMLContentPayload["trigger"]) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(
                () => takeSnapshot(trigger),
                DEBOUNCE_MS,
            );
        }

        // ── 1. navigation trigger ────────────────────────────────

        scheduleSnapshot("navigation");

        // ── 2. scroll trigger ────────────────────────────────────

        document.addEventListener(
            "scroll",
            () => {
                const currentY = window.scrollY;
                scrollAccum += Math.abs(currentY - lastScrollY);
                lastScrollY = currentY;

                if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
                scrollIdleTimer = setTimeout(() => {
                    const vpHeight = window.innerHeight;
                    if (
                        vpHeight > 0 &&
                        scrollAccum >= vpHeight * SCROLL_THRESHOLD
                    ) {
                        scrollAccum = 0;
                        scheduleSnapshot("scroll");
                    }
                }, SCROLL_IDLE_MS);
            },
            { passive: true, signal },
        );

        // ── 3. mutation trigger ──────────────────────────────────

        function isSignificantNode(node: Node): boolean {
            if (!(node instanceof HTMLElement)) return false;

            const role = node.getAttribute("role");
            if (role === "dialog" || role === "alertdialog" || role === "alert")
                return true;
            if (node.getAttribute("aria-modal") === "true") return true;

            const style = getComputedStyle(node);
            if (style.position === "fixed") {
                const text = node.innerText ?? "";
                if (text.length > 20) return true;
            }

            const rect = node.getBoundingClientRect();
            const inViewport =
                rect.top < window.innerHeight &&
                rect.bottom > 0 &&
                rect.left < window.innerWidth &&
                rect.right > 0;
            if (inViewport) {
                const text = node.innerText ?? "";
                if (text.length >= MUTATION_TEXT_MIN) return true;
            }

            return false;
        }

        function startObserver() {
            if (!document.body) return;

            observer = new MutationObserver((mutations) => {
                let dominated = false;
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (isSignificantNode(node)) {
                            dominated = true;
                            break;
                        }
                    }
                    if (dominated) break;
                }
                if (!dominated) return;

                // extra settle time before entering the debounce
                if (settleTimer) clearTimeout(settleTimer);
                settleTimer = setTimeout(
                    () => scheduleSnapshot("mutation"),
                    SETTLE_MS,
                );
            });

            observer.observe(document.body, { childList: true, subtree: true });
        }

        startObserver();

        // ── inner tap + teardown ─────────────────────────────────

        const teardownInner = inner(sink);

        return () => {
            ac.abort();
            if (observer) observer.disconnect();
            if (debounceTimer) clearTimeout(debounceTimer);
            if (settleTimer) clearTimeout(settleTimer);
            if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
            teardownInner();
        };
    };
};

// ── helpers ──────────────────────────────────────────────────────────

function simpleHash(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h.toString(36);
}
