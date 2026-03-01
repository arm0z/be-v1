import type { Bundle, BundleEntry } from "./types.ts";

import type { FormFieldInfo } from "../event/types.ts";

function formatMinute(ts: number): string {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
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

function truncateList(items: string[], show = 3): string {
    if (items.length <= show) return items.join(", ");
    return `${items.slice(0, show).join(", ")} [+${items.length - show}]`;
}

function formatField(f: FormFieldInfo): string | null {
    const name = f.label ?? f.name ?? f.placeholder ?? f.tag;
    if (f.redacted) return `  ${name}: [redacted]`;
    if (f.checked !== undefined)
        return `  ${name}: ${f.checked ? "checked" : "unchecked"}`;
    if (f.selectedText) return `  ${name}: "${truncate(f.selectedText, 50)}"`;
    if (f.value)
        return `  ${name}: "${truncate(f.value, 500, { fromCenter: true })}"`;
    return null;
}

function formatFields(fields: FormFieldInfo[]): string {
    const rendered = fields
        .map(formatField)
        .filter((line): line is string => line !== null);
    if (rendered.length <= 10) return rendered.join("\n");
    const head = rendered.slice(0, 5);
    const tail = rendered.slice(-5);
    return [
        ...head,
        `  ...: ... (${rendered.length - 10} fields truncated)`,
        ...tail,
    ].join("\n");
}

function translateEntry(c: BundleEntry): string | null {
    switch (c.type) {
        // ── captures ────────────────────────────────────────────
        case "input.keystroke_batch":
            return `type "${c.payload.text}"`;
        case "input.keystroke": {
            const { key, modifiers } = c.payload;
            let prefix = "";
            if (modifiers.ctrl) prefix += "Ctrl+";
            if (modifiers.alt) prefix += "Alt+";
            if (modifiers.shift) prefix += "Shift+";
            if (modifiers.meta) prefix += "Meta+";
            return `key ${prefix}${key}`;
        }
        case "input.click":
            return c.payload.target.href
                ? `click "${c.payload.target.text ?? ""}" ${truncate(c.payload.target.href, 40)}`
                : `click "${c.payload.target.text ?? ""}"`;
        case "input.double_click":
            return `dblclick "${c.payload.target.text ?? ""}"`;
        case "input.context_menu":
            return `rclick "${c.payload.target.text ?? ""}"`;
        case "input.scroll":
            return `scroll ${c.payload.percent}%`;
        case "input.selection":
            return `select "${truncate(c.payload.text, 500, { fromCenter: true })}"`;

        case "input.copy":
            return `copy ${c.payload.length}`;
        case "input.paste":
            return `paste ${c.payload.length}->${c.payload.target.tag}`;
        case "input.form_focus": {
            const label =
                c.payload.target.name ??
                c.payload.target.placeholder ??
                c.payload.target.tag;
            if (!c.payload.form?.fields.length) return `focus ${label}`;
            const fieldBlock = formatFields(c.payload.form.fields);
            return fieldBlock
                ? `focus ${label}\n${fieldBlock}`
                : `focus ${label}`;
        }
        case "input.form_change":
            return c.payload.redacted
                ? `set ${c.payload.target.tag} [redacted]`
                : `set ${c.payload.target.tag} "${truncate(c.payload.value ?? "", 50)}"`;
        case "input.form_submit":
            return `submit ${c.payload.fieldCount}f->${truncate(c.payload.action, 40)}`;
        case "html.content":
            return `page "${c.payload.title}" ${c.payload.text}`;
        case "file.content":
            return `file ${truncate(c.payload.url, 40)} ${c.payload.text}`;
        case "outlook.navigate":
            return `nav ${c.payload.folder}${c.payload.messageId ? ` ${truncate(c.payload.messageId, 20)}` : ""}`;
        case "outlook.send":
            return "send email";
        case "outlook.discard":
            return "discard draft";
        case "outlook.content": {
            const p = c.payload;
            const lines: string[] = [
                `email (${p.mode}) "${truncate(p.subject, 40)}"`,
            ];
            if (p.from) lines.push(`  from: ${p.from}`);
            if (p.to.length) lines.push(`  to: ${truncateList(p.to)}`);
            if (p.cc.length) lines.push(`  cc: ${truncateList(p.cc)}`);
            if (p.bcc.length) lines.push(`  bcc: ${truncateList(p.bcc)}`);
            if (p.attachments.length)
                lines.push(
                    `  ${p.attachments.length} attachments: ${truncateList(p.attachments)}`,
                );
            if (p.body)
                lines.push(`  ${truncate(p.body, 1000, { fromCenter: true })}`);
            return lines.join("\n");
        }

        // ── signals ─────────────────────────────────────────────
        case "nav.completed":
            return `nav "${c.payload.title}" ${truncate(c.payload.url, 40)}`;
        case "nav.spa":
            return `nav "${c.payload.title}" ${truncate(c.payload.url, 40)}`;
        case "nav.title_changed":
            return `title->"${c.payload.title}"`;
        case "tab.created":
            return `newtab "${c.payload.title}" ${truncate(c.payload.url, 40)}`;
        case "tab.closed":
            return `closetab`;
        case "attention.visible":
            return c.payload.visible ? `focus` : `blur`;
        case "media.audio":
            return c.payload.audible ? `audio on` : `audio off`;
        case "media.download":
            return `dl "${c.payload.filename}" ${c.payload.state}`;

        default:
            return null;
    }
}

const COLLAPSIBLE: ReadonlySet<string> = new Set([
    "input.scroll",
    "input.selection",
    "attention.visible",
    "media.audio",
    "outlook.content",
]);

/** Collapse consecutive entries of the same collapsible type, keeping only the last in each run. */
function collapse(entries: BundleEntry[]): BundleEntry[] {
    const result: BundleEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
        if (
            COLLAPSIBLE.has(entries[i].type) &&
            i + 1 < entries.length &&
            entries[i].type === entries[i + 1].type
        )
            continue;
        result.push(entries[i]);
    }
    return result;
}

export function translate(bundle: Bundle): string {
    if (bundle.captures.length === 0) return "";

    const entries = collapse(bundle.captures);
    const lines: string[] = [];
    let lastMinute = "";

    for (const c of entries) {
        const text = translateEntry(c);
        if (!text) continue;

        const minute = formatMinute(c.timestamp);
        if (minute !== lastMinute) {
            lines.push(`[${minute}]`);
            lastMinute = minute;
        }
        lines.push(text);
    }
    return lines.join("\n");
}
