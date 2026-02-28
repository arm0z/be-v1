// TODO: impl

import type { Adapter, FileContentPayload } from "../types.ts";
import { dev } from "../dev.ts";

export const FILE_CONTENT = "file.content" as const;
export type { FileContentPayload };

// ── file type categorization ────────────────────────────────────────

type FileCategory =
    | "text"
    | "markup"
    | "image"
    | "audio"
    | "video"
    | "pdf"
    | "binary";

const TEXT_EXTS = new Set([
    "txt",
    "md",
    "csv",
    "tsv",
    "log",
    "json",
    "jsonl",
    "xml",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "sh",
    "bash",
    "zsh",
    "fish",
    "bat",
    "cmd",
    "ps1",
    "py",
    "pyw",
    "rb",
    "pl",
    "pm",
    "php",
    "js",
    "mjs",
    "cjs",
    "ts",
    "mts",
    "cts",
    "jsx",
    "tsx",
    "vue",
    "svelte",
    "astro",
    "c",
    "h",
    "cpp",
    "hpp",
    "cc",
    "cxx",
    "cs",
    "java",
    "kt",
    "kts",
    "scala",
    "go",
    "rs",
    "swift",
    "m",
    "mm",
    "r",
    "R",
    "lua",
    "zig",
    "nim",
    "dart",
    "ex",
    "exs",
    "erl",
    "hrl",
    "hs",
    "lhs",
    "ml",
    "mli",
    "fs",
    "fsi",
    "fsx",
    "clj",
    "cljs",
    "cljc",
    "lisp",
    "el",
    "scm",
    "rkt",
    "sql",
    "graphql",
    "gql",
    "proto",
    "tf",
    "hcl",
    "dockerfile",
    "makefile",
    "cmake",
    "gradle",
    "sbt",
    "cabal",
    "lock",
    "sum",
    "mod",
]);

const MARKUP_EXTS = new Set([
    "html",
    "htm",
    "xhtml",
    "svg",
    "mathml",
    "rss",
    "atom",
    "xsl",
    "xslt",
]);

const IMAGE_EXTS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "bmp",
    "ico",
    "webp",
    "avif",
    "tiff",
    "tif",
    "svg",
    "heic",
    "heif",
]);

const AUDIO_EXTS = new Set([
    "mp3",
    "wav",
    "ogg",
    "flac",
    "aac",
    "wma",
    "m4a",
    "opus",
]);

const VIDEO_EXTS = new Set([
    "mp4",
    "webm",
    "mkv",
    "avi",
    "mov",
    "wmv",
    "flv",
    "m4v",
    "ogv",
]);

const BINARY_EXTS = new Set([
    "zip",
    "tar",
    "gz",
    "bz2",
    "xz",
    "7z",
    "rar",
    "iso",
    "dmg",
    "exe",
    "msi",
    "deb",
    "rpm",
    "apk",
    "wasm",
    "dll",
    "so",
    "dylib",
    "bin",
]);

function getExtension(url: string): string {
    try {
        const pathname = new URL(url).pathname;
        const dot = pathname.lastIndexOf(".");
        if (dot === -1) return "";
        return pathname.slice(dot + 1).toLowerCase();
    } catch {
        return "";
    }
}

function categorize(ext: string): FileCategory {
    if (ext === "pdf") return "pdf";
    if (TEXT_EXTS.has(ext)) return "text";
    if (MARKUP_EXTS.has(ext)) return "markup";
    if (IMAGE_EXTS.has(ext)) return "image";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (VIDEO_EXTS.has(ext)) return "video";
    if (BINARY_EXTS.has(ext)) return "binary";
    return "text"; // default: attempt text extraction
}

// ── extraction ──────────────────────────────────────────────────────

const MAX_BYTES = 65_000;

async function extractPdfText(url: string): Promise<string> {
    const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
    GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
    ).href;

    const doc = await getDocument(url).promise;
    const chunks: string[] = [];
    let byteLen = 0;

    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ");
        byteLen += pageText.length;
        if (byteLen > MAX_BYTES) {
            chunks.push(pageText.slice(0, byteLen - MAX_BYTES));
            break;
        }
        chunks.push(pageText);
    }

    return chunks.join("\n");
}

async function extractText(
    category: FileCategory,
    url: string,
): Promise<string> {
    switch (category) {
        case "text":
            return (document.body?.innerText ?? "").slice(0, MAX_BYTES);

        case "pdf":
            return extractPdfText(url);

        case "markup":
            return (document.documentElement?.outerHTML ?? "").slice(
                0,
                MAX_BYTES,
            );

        case "image":
        case "audio":
        case "video":
        case "binary": {
            const inner = (document.body?.innerText ?? "").trim();
            if (inner.length > 20) return inner.slice(0, MAX_BYTES);
            const filename = decodeURIComponent(
                new URL(url).pathname.split("/").pop() ?? url,
            );
            return `[File: ${filename}]`;
        }
    }
}

// ── adapter ─────────────────────────────────────────────────────────

/** Reads file:// page content after load, categorized by file type. */
export const fileAdapter: Adapter = (inner) => {
    return (sink) => {
        const teardownInner = inner(sink);
        let snapshotTaken = false;

        async function snapshot() {
            if (snapshotTaken) return;
            snapshotTaken = true;

            const url = window.location.href;
            const ext = getExtension(url);
            const category = categorize(ext);
            const text = await extractText(category, url);

            if (!text) return;

            dev.log(
                "adapter",
                FILE_CONTENT,
                `file content read (${category})`,
                {
                    category,
                    ext,
                    length: text.length,
                },
            );

            sink({
                type: FILE_CONTENT,
                timestamp: Date.now(),
                context: "root",
                payload: {
                    url,
                    text,
                    length: text.length,
                } satisfies FileContentPayload,
            });
        }

        if (document.readyState === "complete") {
            snapshot();
        } else {
            window.addEventListener("load", snapshot, { once: true });
        }

        return () => {
            window.removeEventListener("load", snapshot);
            teardownInner();
        };
    };
};
