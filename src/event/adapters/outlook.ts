import type { Adapter, Capture, OutlookContentPayload } from "../types.ts";

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
const SUBJECT_INPUT = 'input[aria-label="Subject"]';
const SEND_BTN = '[data-testid="ComposeSendButton"], button[aria-label="Send"]';
const DISCARD_BTN = 'button#discardCompose, button[aria-label="Discard"]';

const BODY_BUDGET = 65_536;
const READ_SUBJECT = 'span[id$="_SUBJECT"][role="heading"]';
const READ_FROM = 'span[aria-label^="From:"]';
const READ_BODY = 'div[id^="UniqueMessageBody_"][role="document"]';
const READ_ATTACH = 'div[aria-label="Attachments"] button';
const COMPOSE_ATTACH = '[data-testid="AttachmentCard"]';
const COMPOSE_ATTACH_FALLBACK = 'div[aria-label^="Attachment"]';

const NAV_SETTLE_MS = 300;

// ── DOM-based context resolution ─────────────────────────────────────

function resolveDomContext(folder: string): string | null {
    const subjectEl = document.querySelector<HTMLElement>(READ_SUBJECT);
    const subject = subjectEl?.innerText?.trim();
    if (!subject) return null;
    const fromEl = document.querySelector(READ_FROM);
    const from = (fromEl?.getAttribute("aria-label") ?? "")
        .replace(/^From:\s*/, "")
        .trim();
    return `${folder}:${shortHash(subject + from)}`;
}

function extractDraftId(): string | null {
    const el = document.querySelector<HTMLInputElement>(SUBJECT_INPUT);
    if (!el) return null;
    const m = /^MSG_(.+)_SUBJECT$/.exec(el.id);
    return m?.[1] ?? null;
}

function detectComposeMode(
    subjectValue: string,
): "compose" | "reply" | "forward" {
    const trimmed = subjectValue.trimStart();
    if (/^Re:/i.test(trimmed)) return "reply";
    if (/^Fw:/i.test(trimmed)) return "forward";
    return "compose";
}

function resolveOverlayCtx(): {
    ctx: string;
    mode: "compose" | "reply" | "forward";
    draftId: string | null;
} | null {
    if (!document.querySelector(COMPOSE_EDITOR)) return null;
    const subjectEl = document.querySelector<HTMLInputElement>(SUBJECT_INPUT);
    const mode = detectComposeMode(subjectEl?.value ?? "");
    const draftId = extractDraftId();
    const ctx = draftId ? `${mode}:${shortHash(draftId)}` : mode;
    return { ctx, mode, draftId };
}

// ── content extraction ──────────────────────────────────────────────

function extractReadRecipients(field: "To" | "Cc"): string[] {
    const container = document.querySelector(`div[aria-label^="${field}:"]`);
    if (!container) return [];
    const pills = container.querySelectorAll("[data-lpc-hover-target-id]");
    if (pills.length > 0) {
        return Array.from(pills)
            .map((s) => s.textContent?.trim())
            .filter((s): s is string => !!s);
    }
    const label = container.getAttribute("aria-label") ?? "";
    const after = label.replace(new RegExp(`^${field}:\\s*`), "");
    return after ? after.split(/,\s*/).filter(Boolean) : [];
}

function extractComposeRecipients(field: "To" | "Cc" | "Bcc"): string[] {
    const container = document.querySelector<HTMLElement>(
        `div[aria-label="${field}"][contenteditable="true"]`,
    );
    if (!container) return [];
    const pills = container.querySelectorAll("[data-lpc-hover-target-id]");
    if (pills.length > 0) {
        return Array.from(pills)
            .map((p) => p.textContent?.trim())
            .filter((s): s is string => !!s);
    }
    return container.innerText
        .split(/[;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function extractReadAttachments(): string[] {
    return Array.from(document.querySelectorAll(READ_ATTACH))
        .map((el) => el.textContent?.trim() ?? "")
        .filter(Boolean);
}

function extractComposeAttachments(): string[] {
    const cards = document.querySelectorAll(COMPOSE_ATTACH);
    if (cards.length > 0) {
        return Array.from(cards)
            .map((el) => el.textContent?.trim() ?? "")
            .filter(Boolean);
    }
    return Array.from(document.querySelectorAll(COMPOSE_ATTACH_FALLBACK))
        .map((el) =>
            (el.getAttribute("aria-label") ?? "")
                .replace(/^Attachment[:\s]*/i, "")
                .trim(),
        )
        .filter(Boolean);
}

function extractReadSnapshot(): OutlookContentPayload | null {
    const subjectEl = document.querySelector<HTMLElement>(READ_SUBJECT);
    if (!subjectEl) return null;
    const fromEl = document.querySelector(READ_FROM);
    const fromLabel = fromEl?.getAttribute("aria-label") ?? "";
    const bodyEl = document.querySelector<HTMLElement>(READ_BODY);
    let body = bodyEl?.innerText ?? "";
    if (body.length > BODY_BUDGET) body = body.slice(0, BODY_BUDGET);
    return {
        mode: "read",
        subject: subjectEl.innerText?.trim() ?? "",
        from: fromLabel.replace(/^From:\s*/, "").trim() || null,
        to: extractReadRecipients("To"),
        cc: extractReadRecipients("Cc"),
        bcc: [],
        body,
        attachments: extractReadAttachments(),
        draftId: null,
    };
}

function extractComposeSnapshot(): OutlookContentPayload | null {
    const subjectEl = document.querySelector<HTMLInputElement>(SUBJECT_INPUT);
    if (!subjectEl) return null;
    const subject = subjectEl.value ?? "";
    const bodyEl = document.querySelector<HTMLElement>(COMPOSE_EDITOR);
    let body = bodyEl?.innerText ?? "";
    if (body.length > BODY_BUDGET) body = body.slice(0, BODY_BUDGET);
    return {
        mode: detectComposeMode(subject),
        subject,
        from: null,
        to: extractComposeRecipients("To"),
        cc: extractComposeRecipients("Cc"),
        bcc: extractComposeRecipients("Bcc"),
        body,
        attachments: extractComposeAttachments(),
        draftId: extractDraftId(),
    };
}

function extractSnapshot(): OutlookContentPayload | null {
    return extractComposeSnapshot() ?? extractReadSnapshot();
}

// ── adapter ──────────────────────────────────────────────────────────

const POLL_MS = 300;

/** Rewrites context per-email based on URL. Emits outlook.navigate on route change.
 *  Unsupported paths (deleted, junk, archive, search) fall back to "other". */
export const outlookAdapter: Adapter = (inner) => {
    return (sink) => {
        let lastPath = window.location.pathname;
        const initRoute = parseOutlookUrl(lastPath);
        let currentCtx = initRoute.messageId
            ? resolveDomContext(initRoute.folder) ??
              `${initRoute.folder}:${shortHash(initRoute.messageId)}`
            : initRoute.folder;

        let navSettleTimer: ReturnType<typeof setTimeout> | null = null;

        function cancelSettle(): void {
            if (navSettleTimer) {
                clearTimeout(navSettleTimer);
                navSettleTimer = null;
            }
        }

        // Layer 2: compose overlay state
        let overlayCtx: string | null = null;
        let overlayMode: "compose" | "reply" | "forward" | null = null;
        let overlayDraftId: string | null = null;
        let pendingAction: "send" | "discard" | null = null;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;

        function effectiveCtx(): string {
            return overlayCtx ?? currentCtx;
        }

        // Layer 3: content snapshots
        const snapshotCtxSeen = new Set<string>();
        let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

        function maybeSnapshot() {
            const ctx = effectiveCtx();
            if (snapshotCtxSeen.has(ctx)) return;
            const payload = extractSnapshot();
            if (!payload) return;
            snapshotCtxSeen.add(ctx);
            const cap: Capture = {
                type: "outlook.content",
                timestamp: Date.now(),
                context: ctx,
                payload,
            };
            dev.log("adapter", "outlook.content", `mode=${payload.mode}`, cap);
            sink(cap);
        }

        function scheduleSnapshot() {
            if (snapshotTimer) clearTimeout(snapshotTimer);
            if (snapshotCtxSeen.has(effectiveCtx())) return;
            snapshotTimer = setTimeout(() => {
                snapshotTimer = null;
                maybeSnapshot();
            }, 10_000);
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

            const { folder, messageId } = parseOutlookUrl(path);

            // Folder-only navigation (list view): resolve immediately, no DOM to hash.
            if (!messageId) {
                cancelSettle();
                const prevCtx = currentCtx;
                currentCtx = folder;
                if (currentCtx !== prevCtx) {
                    emitNavigate(prevCtx, currentCtx);
                    scheduleSnapshot();
                    return true;
                }
                return false;
            }

            // Message navigation: defer until DOM settles with new email content.
            cancelSettle();
            const urlFallback = `${folder}:${shortHash(messageId)}`;
            navSettleTimer = setTimeout(() => {
                navSettleTimer = null;
                const prevCtx = currentCtx;
                currentCtx = resolveDomContext(folder) ?? urlFallback;
                if (currentCtx !== prevCtx) {
                    emitNavigate(prevCtx, currentCtx);
                    scheduleSnapshot();
                }
            }, NAV_SETTLE_MS);

            return false; // No context change yet — settling
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
                    scheduleSnapshot();
                } else if (!result && overlayCtx) {
                    // Compose pane disappeared
                    const prevCtx = overlayCtx;
                    const savedMode = overlayMode!;
                    const savedDraftId = overlayDraftId;
                    const action = pendingAction ?? "send"; // infer send if no explicit action

                    // Emit action capture
                    const actionCap: Capture = {
                        type:
                            action === "discard"
                                ? "outlook.discard"
                                : "outlook.send",
                        timestamp: Date.now(),
                        context: prevCtx,
                        payload: { mode: savedMode, draftId: savedDraftId },
                    };
                    dev.log(
                        "adapter",
                        actionCap.type,
                        `${savedMode} ${savedDraftId ?? "(no id)"}`,
                        actionCap,
                    );
                    sink(actionCap);

                    // Clear overlay state
                    overlayCtx = null;
                    overlayMode = null;
                    overlayDraftId = null;
                    pendingAction = null;

                    // Emit navigate reverting to URL-based context
                    emitNavigate(prevCtx, currentCtx);
                    scheduleSnapshot();
                }
            }, 100);
        });
        composeObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });

        // Layer 2: delegated click listener for send/discard
        const ac = new AbortController();
        document.addEventListener(
            "click",
            (e) => {
                const target = e.target as HTMLElement;
                if (target.closest(SEND_BTN)) {
                    pendingAction = "send";
                    maybeSnapshot();
                } else if (target.closest(DISCARD_BTN)) {
                    pendingAction = "discard";
                    maybeSnapshot();
                }
            },
            { capture: true, signal: ac.signal },
        );

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
            cancelSettle();
            if (settleTimer) clearTimeout(settleTimer);
            if (snapshotTimer) clearTimeout(snapshotTimer);
            teardownInner();
        };
    };
};
