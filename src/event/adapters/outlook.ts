import type { Adapter, Capture } from "../types.ts";

import { dev } from "../dev.ts";

// ── URL parsing ──────────────────────────────────────────────────────

/** Supported URL segments → context folder. Unsupported paths are filtered out. */
const FOLDER_MAP: Record<string, string> = {
    inbox: "inbox",
    sentitems: "sent",
    drafts: "drafts",
    compose: "compose",
    deeplink: "compose",
};

const ROUTE_RE =
    /\/mail\/(?:([a-z]+)\/(?:id\/(.+?)(?:\/|$)|rp\/(.+?)(?:\/|$))?)?$/;

interface OutlookRoute {
    folder: string;
    messageId: string | null;
}

/** Compose uses direct IDs: /mail/compose/{id} (no id/ prefix) */
const COMPOSE_RE = /\/mail\/compose\/([^/]+)\/?$/;

function parseOutlookUrl(pathname: string): OutlookRoute {
    const m = ROUTE_RE.exec(pathname);
    if (!m) {
        const cm = COMPOSE_RE.exec(pathname);
        if (cm) return { folder: "compose", messageId: cm[1] };
        return { folder: "other", messageId: null };
    }

    const segment = m[1] ?? null;
    if (!segment) return { folder: "other", messageId: null };

    const folder = FOLDER_MAP[segment] ?? "other";
    const messageId = m[2] ?? m[3] ?? null;
    return { folder, messageId };
}

// ── hash ─────────────────────────────────────────────────────────────

function shortHash(id: string): string {
    let h = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193); // FNV prime
    }
    return (h >>> 0).toString(36);
}

// ── compose detection helpers ────────────────────────────────────────

const COMPOSE_EDITOR = 'div[aria-label="Message body"][contenteditable="true"]';
const SUBJECT_INPUT  = 'input[aria-label="Subject"]';
const SEND_BTN       = '[data-testid="ComposeSendButton"], button[aria-label="Send"]';
const DISCARD_BTN    = 'button#discardCompose, button[aria-label="Discard"]';

function extractDraftId(): string | null {
    const el = document.querySelector<HTMLInputElement>(SUBJECT_INPUT);
    if (!el) return null;
    const m = /^MSG_(.+)_SUBJECT$/.exec(el.id);
    return m?.[1] ?? null;
}

function detectComposeMode(subjectValue: string): "compose" | "reply" | "forward" {
    const trimmed = subjectValue.trimStart();
    if (/^Re:/i.test(trimmed)) return "reply";
    if (/^Fw:/i.test(trimmed)) return "forward";
    return "compose";
}

function resolveOverlayCtx(): { ctx: string; mode: "compose" | "reply" | "forward"; draftId: string | null } | null {
    if (!document.querySelector(COMPOSE_EDITOR)) return null;
    const subjectEl = document.querySelector<HTMLInputElement>(SUBJECT_INPUT);
    const mode = detectComposeMode(subjectEl?.value ?? "");
    const draftId = extractDraftId();
    const ctx = draftId ? `${mode}:${shortHash(draftId)}` : mode;
    return { ctx, mode, draftId };
}

// ── context resolution ───────────────────────────────────────────────

function resolveContext(pathname: string): string {
    const { folder, messageId } = parseOutlookUrl(pathname);
    if (!messageId) return folder;
    return `${folder}:${shortHash(messageId)}`;
}

// ── adapter ──────────────────────────────────────────────────────────

const POLL_MS = 300;

/** Rewrites context per-email based on URL. Emits outlook.navigate on route change.
 *  Unsupported paths (deleted, junk, archive, search) fall back to "other". */
export const outlookAdapter: Adapter = (inner) => {
    return (sink) => {
        let lastPath = window.location.pathname;
        let currentCtx = resolveContext(lastPath);

        // Layer 2: compose overlay state
        let overlayCtx: string | null = null;
        let overlayMode: "compose" | "reply" | "forward" | null = null;
        let overlayDraftId: string | null = null;
        let pendingAction: "send" | "discard" | null = null;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;

        function effectiveCtx(): string {
            return overlayCtx ?? currentCtx;
        }

        function emitNavigate(prevCtx: string, newCtx: string) {
            const { folder, messageId } = parseOutlookUrl(
                window.location.pathname,
            );
            const cap: Capture = {
                type: "outlook.navigate",
                timestamp: Date.now(),
                context: newCtx,
                payload: { folder, messageId, previousContext: prevCtx },
            };
            dev.log(
                "adapter",
                "outlook.navigate",
                `${prevCtx} → ${newCtx}`,
                cap,
            );
            sink(cap);
        }

        function checkNavigation(): boolean {
            const path = window.location.pathname;
            if (path === lastPath) return false;
            lastPath = path;
            const prevCtx = currentCtx;
            currentCtx = resolveContext(path);
            if (currentCtx !== prevCtx) {
                emitNavigate(prevCtx, currentCtx);
                return true;
            }
            return false;
        }

        // Layer 2: MutationObserver for compose pane
        const composeObserver = new MutationObserver(() => {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
                settleTimer = null;
                const result = resolveOverlayCtx();

                if (result && !overlayCtx) {
                    // Compose pane appeared
                    const prevCtx = effectiveCtx();
                    overlayCtx = result.ctx;
                    overlayMode = result.mode;
                    overlayDraftId = result.draftId;
                    emitNavigate(prevCtx, overlayCtx);
                } else if (!result && overlayCtx) {
                    // Compose pane disappeared
                    const prevCtx = overlayCtx;
                    const savedMode = overlayMode!;
                    const savedDraftId = overlayDraftId;
                    const action = pendingAction ?? "send"; // infer send if no explicit action

                    // Emit action capture
                    const actionCap: Capture = {
                        type: action === "discard" ? "outlook.discard" : "outlook.send",
                        timestamp: Date.now(),
                        context: prevCtx,
                        payload: { mode: savedMode, draftId: savedDraftId },
                    };
                    dev.log("adapter", actionCap.type, `${savedMode} ${savedDraftId ?? "(no id)"}`, actionCap);
                    sink(actionCap);

                    // Clear overlay state
                    overlayCtx = null;
                    overlayMode = null;
                    overlayDraftId = null;
                    pendingAction = null;

                    // Emit navigate reverting to URL-based context
                    emitNavigate(prevCtx, currentCtx);
                }
            }, 100);
        });
        composeObserver.observe(document.body, { childList: true, subtree: true });

        // Layer 2: delegated click listener for send/discard
        const ac = new AbortController();
        document.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            if (target.closest(SEND_BTN)) pendingAction = "send";
            else if (target.closest(DISCARD_BTN)) pendingAction = "discard";
        }, { capture: true, signal: ac.signal });

        // Proactive: poll for URL changes the tap won't see
        const pollTimer = setInterval(checkNavigation, POLL_MS);

        // Proactive: back/forward
        window.addEventListener("popstate", () => checkNavigation(), {
            signal: ac.signal,
        });

        // Reactive: rewrite context on every inner capture
        const teardownInner = inner((capture) => {
            checkNavigation();
            sink({ ...capture, context: effectiveCtx() });
        });

        return () => {
            clearInterval(pollTimer);
            ac.abort();
            composeObserver.disconnect();
            if (settleTimer) clearTimeout(settleTimer);
            teardownInner();
        };
    };
};
