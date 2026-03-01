import type {
    Capture,
    ClickTarget,
    FormTarget,
    InputClickPayload,
    InputCompositionPayload,
    InputContextMenuPayload,
    InputCopyPayload,
    InputDoubleClickPayload,
    InputFormChangePayload,
    InputFormFocusPayload,
    InputFormSubmitPayload,
    InputKeystrokePayload,
    InputPastePayload,
    InputScrollPayload,
    InputSelectionPayload,
    KeystrokeTarget,
    Tap,
} from "./types.ts";
import { dev } from "./dev.ts";
import { isSensitiveField } from "./dom-utils.ts";

/** Base Tap: attaches DOM listeners and streams all content-script Captures. */
export function tap(context = "root"): Tap {
    return (sink) => {
        const ac = new AbortController();
        const { signal } = ac;
        const capture = { capture: true, signal } as const;
        const passive = { passive: true, signal } as const;

        // ── Layer 4: Keystrokes ─────────────────────────────────

        document.addEventListener(
            "keydown",
            (e: KeyboardEvent) => {
                const target = e.target instanceof Element ? e.target : null;
                const kt = keystrokeTarget(target);
                const redacted = kt.redacted;
                const cap: Capture = {
                    type: "input.keystroke",
                    timestamp: Date.now(),
                    context,
                    payload: {
                        key: redacted ? "*" : e.key,
                        code: redacted ? "*" : e.code,
                        modifiers: redacted
                            ? {
                                  ctrl: false,
                                  alt: false,
                                  shift: false,
                                  meta: false,
                              }
                            : {
                                  ctrl: e.ctrlKey,
                                  alt: e.altKey,
                                  shift: e.shiftKey,
                                  meta: e.metaKey,
                              },
                        target: kt,
                        repeat: redacted ? false : e.repeat,
                    } satisfies InputKeystrokePayload,
                };
                dev.log("tap", "input.keystroke", "keystroke event", cap);
                sink(cap);
            },
            capture,
        );

        function emitComposition(
            e: CompositionEvent,
            stage: "start" | "update" | "end",
        ) {
            const target = e.target instanceof Element ? e.target : null;
            const kt = keystrokeTarget(target);
            const cap: Capture = {
                type: "input.composition",
                timestamp: Date.now(),
                context,
                payload: {
                    data: kt.redacted ? "*" : (e.data ?? ""),
                    stage,
                    target: kt,
                } satisfies InputCompositionPayload,
            };
            dev.log("tap", "input.composition", `composition ${stage}`, cap);
            sink(cap);
        }

        document.addEventListener(
            "compositionstart",
            (e) => emitComposition(e, "start"),
            capture,
        );
        document.addEventListener(
            "compositionupdate",
            (e) => emitComposition(e, "update"),
            capture,
        );
        document.addEventListener(
            "compositionend",
            (e) => emitComposition(e, "end"),
            capture,
        );

        // ── Layer 5: Mouse & Touch ──────────────────────────────

        function emitClick(e: MouseEvent, type: "input.click") {
            const target = e.target instanceof Element ? e.target : null;
            const cap: Capture = {
                type,
                timestamp: Date.now(),
                context,
                payload: {
                    x: e.clientX,
                    y: e.clientY,
                    button: e.button,
                    target: clickTarget(target),
                } satisfies InputClickPayload,
            };
            dev.log("tap", type, "click event", cap);
            sink(cap);
        }

        function emitPointTarget(
            e: MouseEvent,
            type: "input.double_click" | "input.context_menu",
        ) {
            const target = e.target instanceof Element ? e.target : null;
            const payload = {
                x: e.clientX,
                y: e.clientY,
                target: clickTarget(target),
            };
            const cap: Capture =
                type === "input.double_click"
                    ? {
                          type,
                          timestamp: Date.now(),
                          context,
                          payload: payload satisfies InputDoubleClickPayload,
                      }
                    : {
                          type,
                          timestamp: Date.now(),
                          context,
                          payload: payload satisfies InputContextMenuPayload,
                      };
            dev.log("tap", type, `${type} event`, cap);
            sink(cap);
        }

        document.addEventListener(
            "click",
            (e) => emitClick(e, "input.click"),
            capture,
        );
        document.addEventListener(
            "auxclick",
            (e) => emitClick(e, "input.click"),
            capture,
        );
        document.addEventListener(
            "dblclick",
            (e) => emitPointTarget(e, "input.double_click"),
            capture,
        );
        document.addEventListener(
            "contextmenu",
            (e) => emitPointTarget(e, "input.context_menu"),
            capture,
        );

        // ── Layer 6: Scroll ─────────────────────────────────────

        document.addEventListener(
            "scroll",
            () => {
                const docEl = document.documentElement;
                const cap: Capture = {
                    type: "input.scroll",
                    timestamp: Date.now(),
                    context,
                    payload: {
                        scrollY: window.scrollY,
                        scrollHeight: docEl.scrollHeight,
                        viewportHeight: window.innerHeight,
                        percent:
                            docEl.scrollHeight > window.innerHeight
                                ? window.scrollY /
                                  (docEl.scrollHeight - window.innerHeight)
                                : 0,
                    } satisfies InputScrollPayload,
                };
                dev.log("tap", "input.scroll", "scroll event", cap);
                sink(cap);
            },
            passive,
        );

        // ── Layer 7: Selection & Clipboard ──────────────────────

        document.addEventListener(
            "selectionchange",
            () => {
                const sel = document.getSelection();
                const text = sel?.toString() ?? "";
                if (!text) return;
                const anchor = sel?.anchorNode?.parentElement;
                const cap: Capture = {
                    type: "input.selection",
                    timestamp: Date.now(),
                    context,
                    payload: {
                        text: text.slice(0, 500),
                        target: {
                            selector: anchor ? minimalSelector(anchor) : "",
                        },
                    } satisfies InputSelectionPayload,
                };
                dev.log("tap", "input.selection", "selection changed", cap);
                sink(cap);
            },
            capture,
        );

        document.addEventListener(
            "copy",
            () => {
                const sel = document.getSelection();
                const text = sel?.toString() ?? "";
                const cap: Capture = {
                    type: "input.copy",
                    timestamp: Date.now(),
                    context,
                    payload: { length: text.length } satisfies InputCopyPayload,
                };
                dev.log("tap", "input.copy", "copy event", cap);
                sink(cap);
            },
            capture,
        );

        document.addEventListener(
            "paste",
            (e: ClipboardEvent) => {
                const target = e.target instanceof Element ? e.target : null;
                const text = e.clipboardData?.getData("text/plain") ?? "";
                const cap: Capture = {
                    type: "input.paste",
                    timestamp: Date.now(),
                    context,
                    payload: {
                        length: text.length,
                        target: {
                            tag: target?.tagName.toLowerCase() ?? "unknown",
                            selector: target ? minimalSelector(target) : "",
                        },
                    } satisfies InputPastePayload,
                };
                dev.log("tap", "input.paste", "paste event", cap);
                sink(cap);
            },
            capture,
        );

        // ── Layer 8: Forms ──────────────────────────────────────

        document.addEventListener(
            "focusin",
            (e: FocusEvent) => {
                const target = e.target instanceof Element ? e.target : null;
                if (!target || !isFormElement(target)) return;
                const cap: Capture = {
                    type: "input.form_focus",
                    timestamp: Date.now(),
                    context,
                    payload: {
                        target: formTarget(target),
                        form: formInfo(target),
                    } satisfies InputFormFocusPayload,
                };
                dev.log("tap", "input.form_focus", "form focus", cap);
                sink(cap);
            },
            capture,
        );

        document.addEventListener(
            "change",
            (e: Event) => {
                const target = e.target instanceof Element ? e.target : null;
                if (!target || !isFormElement(target)) return;
                const isInput = target instanceof HTMLInputElement;
                const sensitive = isSensitiveField(target);
                const cap: Capture = {
                    type: "input.form_change",
                    timestamp: Date.now(),
                    context,
                    payload: {
                        target: {
                            tag: target.tagName.toLowerCase(),
                            type: isInput ? target.type : undefined,
                            selector: minimalSelector(target),
                        },
                        value: sensitive ? undefined : formValue(target),
                        redacted: sensitive,
                    } satisfies InputFormChangePayload,
                };
                dev.log("tap", "input.form_change", "form change", cap);
                sink(cap);
            },
            capture,
        );

        document.addEventListener(
            "submit",
            (e: SubmitEvent) => {
                const form =
                    e.target instanceof HTMLFormElement ? e.target : null;
                if (!form) return;
                const cap: Capture = {
                    type: "input.form_submit",
                    timestamp: Date.now(),
                    context,
                    payload: {
                        action: form.action || "",
                        method: form.method || "get",
                        fieldCount: form.elements.length,
                    } satisfies InputFormSubmitPayload,
                };
                dev.log("tap", "input.form_submit", "form submit", cap);
                sink(cap);
            },
            capture,
        );

        // ── teardown ────────────────────────────────────────────

        return () => {
            ac.abort();
        };
    };
}

// ── helpers ─────────────────────────────────────────────────────────

function minimalSelector(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    // SVG className is SVGAnimatedString, not a string
    const cls =
        typeof el.className === "string" && el.className
            ? `.${el.className.trim().split(/\s+/).join(".")}`
            : "";
    if (cls) return `${tag}${cls}`;
    const parent = el.parentElement;
    if (parent) {
        const parentTag = parent.tagName.toLowerCase();
        return `${parentTag} > ${tag}${cls}`;
    }
    return tag;
}

function closestAnchor(el: Element): HTMLAnchorElement | null {
    return el.closest("a") as HTMLAnchorElement | null;
}

function isFormElement(el: Element): boolean {
    return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el as HTMLElement).isContentEditable
    );
}

function clickTarget(el: Element | null): ClickTarget {
    if (!el) return { tag: "unknown", selector: "" };
    const anchor = closestAnchor(el);
    return {
        tag: el.tagName.toLowerCase(),
        selector: minimalSelector(el),
        text: (el as HTMLElement).innerText?.slice(0, 120) ?? undefined,
        href: anchor ? anchor.href || undefined : undefined,
    };
}

function keystrokeTarget(el: Element | null): KeystrokeTarget {
    if (!el) {
        return {
            tag: "unknown",
            type: undefined,
            selector: "",
            contentEditable: false,
            redacted: false,
        };
    }
    const isInput = el instanceof HTMLInputElement;
    return {
        tag: el.tagName.toLowerCase(),
        type: isInput ? el.type : undefined,
        selector: minimalSelector(el),
        contentEditable: (el as HTMLElement).isContentEditable ?? false,
        redacted: isSensitiveField(el),
    };
}

function formTarget(el: Element): FormTarget {
    const isInput = el instanceof HTMLInputElement;
    return {
        tag: el.tagName.toLowerCase(),
        type: isInput ? el.type : undefined,
        selector: minimalSelector(el),
        name: (el as HTMLInputElement).name || undefined,
        placeholder: (el as HTMLInputElement).placeholder || undefined,
    };
}

function formValue(el: Element): string | undefined {
    if (el instanceof HTMLInputElement) {
        if (el.type === "checkbox" || el.type === "radio") {
            return el.checked ? "checked" : "unchecked";
        }
        return el.value.slice(0, 500);
    }
    if (el instanceof HTMLTextAreaElement) return el.value.slice(0, 500);
    if (el instanceof HTMLSelectElement) return el.value;
    return undefined;
}

function formInfo(el: Element): InputFormFocusPayload["form"] | undefined {
    const form =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
            ? el.form
            : null;
    if (!form) return undefined;
    const fields: InputFormFocusPayload["form"] extends
        | { fields: infer F }
        | undefined
        ? F
        : never = [];
    let count = 0;
    for (const field of form.elements) {
        if (
            !(field instanceof HTMLInputElement) &&
            !(field instanceof HTMLTextAreaElement) &&
            !(field instanceof HTMLSelectElement)
        )
            continue;
        if (field instanceof HTMLInputElement && field.type === "hidden")
            continue;
        if (count >= 50) break;
        count++;
        const isInput = field instanceof HTMLInputElement;
        const sensitive = isSensitiveField(field);
        fields.push({
            tag: field.tagName.toLowerCase(),
            type: isInput ? field.type : undefined,
            name: field.name || undefined,
            label: findLabel(field) || undefined,
            placeholder: (field as HTMLInputElement).placeholder || undefined,
            value: sensitive ? undefined : formValue(field)?.slice(0, 200),
            checked: isInput ? field.checked : undefined,
            disabled: field.disabled,
            redacted: sensitive,
        });
    }
    return {
        selector: minimalSelector(form),
        action: form.action || undefined,
        method: form.method || undefined,
        fields,
    };
}

function findLabel(el: Element): string | undefined {
    if (el.id) {
        const label = document.querySelector(
            `label[for="${CSS.escape(el.id)}"]`,
        );
        if (label) return (label as HTMLElement).innerText?.slice(0, 80);
    }
    const parent = el.closest("label");
    if (parent) return (parent as HTMLElement).innerText?.slice(0, 80);
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.slice(0, 80);
    return undefined;
}
