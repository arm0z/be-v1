import type { Bundle, BundleEntry } from "./types.ts";

import type { FormFieldInfo } from "../event/types.ts";

function formatTime(ts: number): string {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
}

function truncate(
    str: string,
    length: number,
    opts?: { fromCenter?: boolean },
): string {
    if (str.length <= length) return str;
    if (opts?.fromCenter) {
        const half = Math.floor(length / 2);
        return `${str.slice(0, half)}[…]${str.slice(-half)}`;
    }
    return `${str.slice(0, length)}…`;
}

function formatField(f: FormFieldInfo): string {
    const name = f.label ?? f.name ?? f.placeholder ?? f.tag;
    if (f.redacted) return `  ${name}: [redacted]`;
    if (f.checked !== undefined)
        return `  ${name}: ${f.checked ? "checked" : "unchecked"}`;
    if (f.selectedText) return `  ${name}: "${truncate(f.selectedText, 50)}"`;
    if (f.value)
        return `  ${name}: "${truncate(f.value, 500, { fromCenter: true })}"`;
    return `  ${name}: (empty)`;
}

function formatFields(fields: FormFieldInfo[]): string {
    if (fields.length <= 10) {
        return fields.map(formatField).join("\n");
    }
    const head = fields.slice(0, 5).map(formatField);
    const tail = fields.slice(-5).map(formatField);
    return [
        ...head,
        `  ...: ... (${fields.length - 10} fields truncated)`,
        ...tail,
    ].join("\n");
}

function translateEntry(c: BundleEntry): string | null {
    switch (c.type) {
        // ── captures ────────────────────────────────────────────
        case "input.keystroke_batch":
            return `typed "${c.payload.text}"`;
        case "input.keystroke": {
            const { key, modifiers } = c.payload;
            let prefix = "";
            if (modifiers.ctrl) prefix += "Ctrl+";
            if (modifiers.alt) prefix += "Alt+";
            if (modifiers.shift) prefix += "Shift+";
            if (modifiers.meta) prefix += "Meta+";
            return `pressed ${prefix}${key}`;
        }
        case "input.click":
            return c.payload.target.href
                ? `clicked "${c.payload.target.text ?? ""}" (${truncate(c.payload.target.href, 40)})`
                : `clicked "${c.payload.target.text ?? ""}"`;
        case "input.double_click":
            return `double-clicked "${c.payload.target.text ?? ""}"`;
        case "input.context_menu":
            return `right-clicked "${c.payload.target.text ?? ""}"`;
        case "input.scroll":
            return `scrolled to ${c.payload.percent}%`;
        case "input.selection":
            return `selected "${truncate(c.payload.text, 500, { fromCenter: true })}"`;

        case "input.copy":
            return `copied (${c.payload.length} chars)`;
        case "input.paste":
            return `pasted (${c.payload.length} chars) into ${c.payload.target.tag}`;
        case "input.form_focus": {
            const label =
                c.payload.target.name ??
                c.payload.target.placeholder ??
                c.payload.target.tag;
            if (!c.payload.form?.fields.length) return `focused ${label}`;
            return `focused ${label}\n${formatFields(c.payload.form.fields)}`;
        }
        case "input.form_change":
            return c.payload.redacted
                ? `changed ${c.payload.target.tag} to [redacted]`
                : `changed ${c.payload.target.tag} to "${truncate(c.payload.value ?? "", 50)}"`;
        case "input.form_submit":
            return `submitted form (${c.payload.fieldCount} fields) → ${truncate(c.payload.action, 40)}`;
        case "html.content":
            return `page: "${c.payload.title}" - ${c.payload.text}`;
        case "file.content":
            return `file: ${truncate(c.payload.url, 40)} - ${c.payload.text}`;

        // ── signals ─────────────────────────────────────────────
        case "nav.completed":
            return `navigated to "${c.payload.title}" (${truncate(c.payload.url, 40)})`;
        case "nav.spa":
            return `navigated to "${c.payload.title}" (${truncate(c.payload.url, 40)})`;
        case "nav.title_changed":
            return `page title → "${c.payload.title}"`;
        case "tab.created":
            return `opened new tab: "${c.payload.title}" (${truncate(c.payload.url, 40)})`;
        case "tab.closed":
            return `closed tab`;
        case "attention.visible":
            return c.payload.visible
                ? `browser gained focus`
                : `browser lost focus`;
        case "media.audio":
            return c.payload.audible
                ? `audio started playing`
                : `audio stopped`;
        case "media.download":
            return `downloaded "${c.payload.filename}" (${c.payload.state})`;

        default:
            return null;
    }
}

export function translate(bundle: Bundle): string {
    if (bundle.captures.length === 0) return "";

    const lines: string[] = [];
    for (const c of bundle.captures) {
        const text = translateEntry(c);
        if (text) lines.push(`[${formatTime(c.timestamp)}] ${text}`);
    }
    return lines.join("\n");
}
