/**
 * DOM extractor — Firecrawl-inspired markdown extraction.
 *
 * Clones the DOM, strips boilerplate elements, converts to markdown via
 * Turndown.js, and returns cleaned text. Preserves heading hierarchy,
 * lists, tables, links, and code blocks.
 */

import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { isSensitiveField } from "../dom-utils.ts";

// ── boilerplate selectors ────────────────────────────────────────────

const BOILERPLATE_SELECTORS = [
    // Semantic boilerplate
    "nav",
    "footer",
    "header",
    "aside",
    // ARIA roles
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    "[role='complementary']",
    "[role='search']",
    "[role='menu']",
    "[role='menubar']",
    "[role='toolbar']",
    // Common class/ID patterns
    ".navbar",
    ".nav-bar",
    ".navigation",
    ".sidebar",
    ".side-bar",
    ".cookie-banner",
    ".cookie-consent",
    ".cookie-notice",
    ".ad",
    ".ads",
    ".advertisement",
    ".social-share",
    ".social-links",
    ".share-buttons",
    "#footer",
    "#header",
    "#sidebar",
    "#nav",
    "#cookie-banner",
    // Noise elements
    "script",
    "style",
    "noscript",
    "link[rel='stylesheet']",
    "link[rel='preload']",
    "meta",
    "template",
];

const BOILERPLATE_QUERY = BOILERPLATE_SELECTORS.join(", ");

const OVERLAY_SELECTOR = [
    "[role='dialog']",
    "[role='alertdialog']",
    "[role='alert']",
    "[aria-modal='true']",
].join(", ");

// ── Turndown singleton ──────────────────────────────────────────────

const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
});

td.use(gfm);

td.addRule("strip-img", {
    filter: "img",
    replacement: () => "<src>",
});

td.addRule("truncate-urls", {
    filter: "a",
    replacement: (content, node) => {
        const el = node as HTMLAnchorElement;
        const href = el.getAttribute("href") || "";
        if (!href || !content.trim()) return content;
        const truncated = href.length > 40 ? `${href.slice(0, 40)}...` : href;
        return `[${content}](${truncated})`;
    },
});

td.addRule("strip-embed", {
    filter: (node) => {
        const tag = node.nodeName.toLowerCase();
        return tag === "svg" || tag === "canvas" || tag === "iframe";
    },
    replacement: () => "",
});

td.addRule("form-inputs", {
    filter: ["input", "select", "textarea"],
    replacement: (_content, node) => {
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();

        if (el instanceof HTMLInputElement) {
            if (el.type === "hidden") return "";
            const parts = [`[input type="${el.type}"`];
            if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
            if (el.value && !isSensitiveField(el)) {
                parts.push(`value="${el.value}"`);
            }
            parts.push("]");
            return ` ${parts.join(" ")} `;
        }

        if (el instanceof HTMLSelectElement) {
            const selected = el.options[el.selectedIndex]?.text;
            const parts = [`[${tag}`];
            if (el.name) parts.push(`name="${el.name}"`);
            if (selected) parts.push(`selected="${selected}"`);
            parts.push("]");
            return ` ${parts.join(" ")} `;
        }

        if (el instanceof HTMLTextAreaElement) {
            const parts = [`[${tag}`];
            if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
            if (el.value && !isSensitiveField(el)) {
                parts.push(`value="${el.value.slice(0, 200)}"`);
            }
            parts.push("]");
            return ` ${parts.join(" ")} `;
        }

        return "";
    },
});

// ── overlay extraction ──────────────────────────────────────────────

function extractOverlays(root: Document): {
    markdown: string;
    elements: Element[];
} {
    const overlayEls: Element[] = [];
    const parts: string[] = [];

    for (const el of root.querySelectorAll(OVERLAY_SELECTOR)) {
        if (!(el instanceof HTMLElement)) continue;

        try {
            if (
                !el.checkVisibility({
                    checkOpacity: true,
                    checkVisibilityCSS: true,
                })
            )
                continue;
        } catch {
            continue;
        }

        const text = el.innerText?.trim();
        if (!text || text.length < 5) continue;

        overlayEls.push(el);
        parts.push(`**OVERLAY:**\n\n${td.turndown(el)}`);
    }

    return { markdown: parts.join("\n\n"), elements: overlayEls };
}

// ── viewport pruning ────────────────────────────────────────────────

/**
 * Parallel TreeWalker: walk the live DOM and clone in lockstep.
 * For each live element whose bounding rect intersects the viewport,
 * mark the clone counterpart (and ancestors) as "keep". Then remove
 * every clone element not in the keep set, deepest-first.
 */
function pruneToViewport(liveBody: HTMLElement, clone: HTMLElement): void {
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    const liveWalker = document.createTreeWalker(
        liveBody,
        NodeFilter.SHOW_ELEMENT,
    );
    const cloneWalker = document.createTreeWalker(
        clone,
        NodeFilter.SHOW_ELEMENT,
    );

    const keep = new Set<Element>();
    keep.add(clone);

    while (liveWalker.nextNode() && cloneWalker.nextNode()) {
        const liveEl = liveWalker.currentNode as Element;
        const cloneEl = cloneWalker.currentNode as Element;

        const rect = liveEl.getBoundingClientRect();
        const inViewport =
            rect.bottom > 0 &&
            rect.top < vpH &&
            rect.right > 0 &&
            rect.left < vpW &&
            rect.width > 0 &&
            rect.height > 0;

        if (inViewport) {
            let node: Element | null = cloneEl;
            while (node && !keep.has(node)) {
                keep.add(node);
                node = node.parentElement;
            }
        }
    }

    const all: Element[] = [];
    const sweep = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
    while (sweep.nextNode()) {
        all.push(sweep.currentNode as Element);
    }
    for (let i = all.length - 1; i >= 0; i--) {
        if (!keep.has(all[i])) {
            all[i].remove();
        }
    }
}

// ── DOM cleanup ─────────────────────────────────────────────────────

function cleanClone(clone: HTMLElement): void {
    for (const el of clone.querySelectorAll(BOILERPLATE_QUERY)) {
        el.remove();
    }

    for (const el of clone.querySelectorAll("[hidden], [aria-hidden='true']")) {
        el.remove();
    }

    for (const el of clone.querySelectorAll("[style]")) {
        const style = (el as HTMLElement).style;
        if (style.display === "none" || style.visibility === "hidden") {
            el.remove();
        }
    }

    for (const el of clone.querySelectorAll(OVERLAY_SELECTOR)) {
        el.remove();
    }
}

// ── post-processing ─────────────────────────────────────────────────

function postProcess(md: string): string {
    return md.replace(/\n{3,}/g, "\n\n").trim();
}

// ── public API ──────────────────────────────────────────────────────

export interface ExtractDOMOpts {
    overlays?: boolean;
    viewportOnly?: boolean;
    stripBoilerplate?: boolean;
}

const DEFAULTS: Required<ExtractDOMOpts> = {
    overlays: true,
    viewportOnly: true,
    stripBoilerplate: true,
};

/**
 * Extracts cleaned markdown from the current DOM.
 * Returns empty string if there is no document body.
 */
export function extractDOM(opts?: ExtractDOMOpts): string {
    const o = { ...DEFAULTS, ...opts };
    const parts: string[] = [];

    if (o.overlays) {
        const { markdown } = extractOverlays(document);
        if (markdown) parts.push(markdown);
    }

    if (!document.body) return parts.join("\n\n");

    const clone = document.body.cloneNode(true) as HTMLElement;
    if (o.viewportOnly) pruneToViewport(document.body, clone);
    if (o.stripBoilerplate) cleanClone(clone);

    const bodyMd = td.turndown(clone);
    const processed = postProcess(bodyMd);
    if (processed) parts.push(processed);

    return parts.join("\n\n");
}
