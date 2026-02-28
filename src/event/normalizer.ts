import type { Capture, Normalizer as NormalizerFn, Tap } from "./types.ts";

import { dev } from "./dev.ts";

// ── individual normalizers ──────────────────────────────────────────

const KEYSTROKE_FLUSH_MS = 1_000;

/**
 * Batches rapid printable keystrokes into a single event after 1s idle.
 * Non-printable/modified keys flush the buffer and pass through.
 * Flushes on `input.composition` stage=start to prevent IME mixing.
 */
export const keystrokeNormalizer: NormalizerFn = (inner) => {
    return (sink) => {
        let keyBuffer: string[] = [];
        let lastCapture: Extract<Capture, { type: "input.keystroke" }> | null =
            null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        function flush() {
            if (keyBuffer.length === 0 || !lastCapture) return;
            const batched = keyBuffer.join("");
            dev.log(
                "normalizer",
                "input.keystroke",
                `flush: batched ${keyBuffer.length} keystrokes → "${batched}"`,
                { count: keyBuffer.length, key: batched },
            );
            sink({
                ...lastCapture,
                ts: Date.now(),
                payload: { ...lastCapture.payload, key: batched },
            });
            keyBuffer = [];
            lastCapture = null;
        }

        function resetTimer() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(flush, KEYSTROKE_FLUSH_MS);
        }

        const teardownInner = inner((capture) => {
            if (capture.type === "input.keystroke") {
                const { key } = capture.payload;
                const { ctrl, alt, meta } = capture.payload.modifiers;
                if (key.length === 1 && !ctrl && !alt && !meta) {
                    dev.log(
                        "normalizer",
                        "input.keystroke",
                        `buffer: "${key}" (${keyBuffer.length + 1} buffered)`,
                    );
                    keyBuffer.push(key);
                    lastCapture = capture;
                    resetTimer();
                    return;
                }
                dev.log(
                    "normalizer",
                    "input.keystroke",
                    `pass-through: "${key}" (special/modified)`,
                    { key, ctrl, alt, meta },
                );
                flush();
            }
            if (
                capture.type === "input.composition" &&
                capture.payload.stage === "start"
            ) {
                dev.log(
                    "normalizer",
                    "input.composition",
                    "flush: composition start",
                );
                flush();
            }
            if (
                capture.type !== "input.keystroke" &&
                capture.type !== "input.composition"
            ) {
                dev.log(
                    "normalizer",
                    capture.type,
                    "pass-through (keystroke layer)",
                );
            }
            sink(capture);
        });

        return () => {
            flush();
            if (timer) clearTimeout(timer);
            teardownInner();
        };
    };
};

const SCROLL_IDLE_MS = 150;

/**
 * Debounces scroll events. Emits only after scrolling stops for 150ms.
 */
export const scrollNormalizer: NormalizerFn = (inner) => {
    return (sink) => {
        let last: Extract<Capture, { type: "input.scroll" }> | null = null;
        let dropped = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        function flush() {
            if (!last) return;
            dev.log(
                "normalizer",
                "input.scroll",
                `flush: scroll idle (dropped ${dropped} intermediate)`,
                { scrollY: last.payload.scrollY, percent: last.payload.percent },
            );
            sink(last);
            last = null;
            dropped = 0;
        }

        const teardownInner = inner((capture) => {
            if (capture.type === "input.scroll") {
                if (last) dropped++;
                dev.log(
                    "normalizer",
                    "input.scroll",
                    `debounce: scroll event (${dropped} pending)`,
                );
                last = capture;
                if (timer) clearTimeout(timer);
                timer = setTimeout(flush, SCROLL_IDLE_MS);
                return;
            }
            dev.log("normalizer", capture.type, "pass-through (scroll layer)");
            sink(capture);
        });

        return () => {
            flush();
            if (timer) clearTimeout(timer);
            teardownInner();
        };
    };
};

const SELECTION_IDLE_MS = 300;

/**
 * Debounces selection events. Emits after 300ms idle, drops empty selections.
 */
export const selectionNormalizer: NormalizerFn = (inner) => {
    return (sink) => {
        let last: Extract<Capture, { type: "input.selection" }> | null = null;
        let dropped = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        function flush() {
            if (!last) return;
            if (!last.payload.text) {
                dev.log(
                    "normalizer",
                    "input.selection",
                    `drop: empty selection (dropped ${dropped + 1} total)`,
                );
                last = null;
                dropped = 0;
                return;
            }
            dev.log(
                "normalizer",
                "input.selection",
                `flush: selection idle (dropped ${dropped} intermediate)`,
                { text: last.payload.text.slice(0, 80) },
            );
            sink(last);
            last = null;
            dropped = 0;
        }

        const teardownInner = inner((capture) => {
            if (capture.type === "input.selection") {
                if (last) dropped++;
                dev.log(
                    "normalizer",
                    "input.selection",
                    `debounce: selection event (${dropped} pending)`,
                );
                last = capture;
                if (timer) clearTimeout(timer);
                timer = setTimeout(flush, SELECTION_IDLE_MS);
                return;
            }
            dev.log(
                "normalizer",
                capture.type,
                "pass-through (selection layer)",
            );
            sink(capture);
        });

        return () => {
            if (last) {
                dev.log(
                    "normalizer",
                    "input.selection",
                    "teardown: discarding partial selection",
                );
            }
            last = null;
            if (timer) clearTimeout(timer);
            teardownInner();
        };
    };
};

const FORM_FOCUS_DEDUP_MS = 2_000;

/**
 * Strips the form snapshot from rapid re-focus within the same form.
 * If the same form is focused again within 2s, the snapshot is set to undefined.
 */
export const formFocusNormalizer: NormalizerFn = (inner) => {
    return (sink) => {
        let lastFormSelector: string | undefined;
        let lastTs = 0;

        const teardownInner = inner((capture) => {
            if (capture.type === "input.form_focus") {
                const formSel = capture.payload.form?.selector;
                const now = capture.ts;
                const sameForm =
                    formSel !== undefined &&
                    formSel === lastFormSelector &&
                    now - lastTs < FORM_FOCUS_DEDUP_MS;
                lastFormSelector = formSel;
                lastTs = now;
                if (sameForm) {
                    dev.log(
                        "normalizer",
                        "input.form_focus",
                        "dedup: same form re-focused, stripping snapshot",
                        { selector: formSel },
                    );
                    sink({
                        ...capture,
                        payload: { ...capture.payload, form: undefined },
                    });
                    return;
                }
                dev.log(
                    "normalizer",
                    "input.form_focus",
                    "pass-through: new form focus",
                    { selector: formSel },
                );
            }
            if (capture.type !== "input.form_focus") {
                dev.log(
                    "normalizer",
                    capture.type,
                    "pass-through (formFocus layer)",
                );
            }
            sink(capture);
        });

        return () => {
            teardownInner();
        };
    };
};

// ── factory ─────────────────────────────────────────────────────────

export type NormalizerOpts = {
    keystroke?: boolean;
    scroll?: boolean;
    selection?: boolean;
    formFocus?: boolean;
};

/**
 * Composes enabled normalizers into a single Normalizer.
 * Order: keystroke(scroll(selection(formFocus(inner))))
 */
export function normalizerFactory(opts?: NormalizerOpts): NormalizerFn {
    const o = {
        keystroke: true,
        scroll: true,
        selection: true,
        formFocus: true,
        ...opts,
    };

    const layers: NormalizerFn[] = [];
    if (o.formFocus) layers.push(formFocusNormalizer);
    if (o.selection) layers.push(selectionNormalizer);
    if (o.scroll) layers.push(scrollNormalizer);
    if (o.keystroke) layers.push(keystrokeNormalizer);

    if (layers.length === 0) {
        return (inner) => inner;
    }

    return (inner: Tap): Tap => {
        let wrapped = inner;
        for (const layer of layers) {
            wrapped = layer(wrapped);
        }
        return wrapped;
    };
}

/** Default normalizer — all normalizers enabled. Backward compatible. */
export const normalizer: NormalizerFn = normalizerFactory();
