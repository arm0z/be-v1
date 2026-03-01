// ── shared target types ─────────────────────────────────────────────

export interface KeystrokeTarget {
    tag: string;
    type?: string;
    selector: string;
    contentEditable: boolean;
    redacted: boolean;
}

export interface ClickTarget {
    tag: string;
    selector: string;
    text?: string;
    href?: string;
}

export interface FormTarget {
    tag: string;
    type?: string;
    selector: string;
    name?: string;
    placeholder?: string;
}

export interface Bounds {
    top: number;
    left: number;
    width: number;
    height: number;
}

// ── per-event payloads ──────────────────────────────────────────────

// Layer 1: Session Structure

export interface WindowCreatedPayload {
    bounds: Bounds;
}

export type WindowClosedPayload = Record<string, never>;

export interface WindowResizedPayload {
    bounds: Bounds;
}

export interface TabCreatedPayload {
    url: string;
    title: string;
    openerTabId?: string;
}

export interface TabClosedPayload {
    windowId: number;
    isWindowClosing: boolean;
}

// Layer 2: Navigation

export interface NavCompletedPayload {
    url: string;
    title: string;
    transitionType: string;
}

export interface NavSpaPayload {
    url: string;
    title: string;
}

export interface NavTitleChangedPayload {
    title: string;
    url: string;
}

// Layer 3: Attention

export interface AttentionVisiblePayload {
    visible: boolean;
    url: string;
    title: string;
}

// Layer 4: Keystrokes

export interface InputKeystrokePayload {
    key: string;
    code: string;
    modifiers: {
        ctrl: boolean;
        alt: boolean;
        shift: boolean;
        meta: boolean;
    };
    target: KeystrokeTarget;
    repeat: boolean;
}

export interface InputKeystrokeBatchPayload {
    text: string;
    count: number;
    target: KeystrokeTarget;
}

export interface InputCompositionPayload {
    data: string;
    stage: "start" | "update" | "end";
    target: KeystrokeTarget;
}

// Layer 5: Mouse & Touch

export interface InputClickPayload {
    x: number;
    y: number;
    button: number;
    target: ClickTarget;
}

export interface InputDoubleClickPayload {
    x: number;
    y: number;
    target: ClickTarget;
}

export interface InputContextMenuPayload {
    x: number;
    y: number;
    target: ClickTarget;
}

// Layer 6: Scroll

export interface InputScrollPayload {
    scrollY: number;
    scrollHeight: number;
    viewportHeight: number;
    percent: number;
}

// Layer 7: Selection & Clipboard

export interface InputSelectionPayload {
    text: string;
    target: { selector: string };
}

export interface InputCopyPayload {
    length: number;
}

export interface InputPastePayload {
    length: number;
    target: { tag: string; selector: string };
}

// Layer 8: Forms

export interface FormFieldInfo {
    tag: string;
    type?: string;
    name?: string;
    label?: string;
    placeholder?: string;
    value?: string;
    checked?: boolean;
    selectedText?: string;
    disabled: boolean;
    redacted: boolean;
}

export interface InputFormFocusPayload {
    target: FormTarget;
    form?: {
        selector: string;
        action?: string;
        method?: string;
        fields: FormFieldInfo[];
    };
}

export interface InputFormChangePayload {
    target: { tag: string; type?: string; selector: string };
    value?: string;
    redacted: boolean;
}

export interface InputFormSubmitPayload {
    action: string;
    method: string;
    fieldCount: number;
}

// Layer 9: Media & Downloads

export interface MediaAudioPayload {
    audible: boolean;
}

export interface MediaDownloadPayload {
    filename: string;
    url: string;
    mime: string;
    size: number;
    state: string;
}

// ── adapter-specific payloads ───────────────────────────────────────

export interface HTMLContentPayload {
    trigger: "navigation" | "scroll" | "mutation";
    url: string;
    title: string;
    viewport: {
        width: number;
        height: number;
        scrollY: number;
        scrollPercent: number;
    };
    html: string;
    text: string;
}

export interface FileContentPayload {
    url: string;
    text: string;
    length: number;
}

export interface OutlookNavigatePayload {
    folder: string;
    messageId: string | null;
    previousContext: string;
}

export interface OutlookSendPayload {
    mode: "compose" | "reply" | "forward";
    draftId: string | null;
}

export interface OutlookDiscardPayload {
    mode: "compose" | "reply" | "forward";
    draftId: string | null;
}

// ── signals (service-worker-originated events) ─────────────────────

interface BaseSignal<T extends string, P> {
    type: T;
    timestamp: number;
    payload: P;
}

/** SW-originated events that flow into bundles without triggering source transitions. */
export type Signal =
    | BaseSignal<"nav.completed", NavCompletedPayload>
    | BaseSignal<"nav.spa", NavSpaPayload>
    | BaseSignal<"nav.title_changed", NavTitleChangedPayload>
    | BaseSignal<"tab.created", TabCreatedPayload>
    | BaseSignal<"tab.closed", TabClosedPayload>
    | BaseSignal<"attention.visible", AttentionVisiblePayload>
    | BaseSignal<"media.audio", MediaAudioPayload>
    | BaseSignal<"media.download", MediaDownloadPayload>;

// ── discriminated union ─────────────────────────────────────────────

/** Content-script capture: flows through the pipeline before the service worker stamps it. */
interface BaseCapture<T extends string, P> {
    type: T;
    timestamp: number;
    context: string;
    payload: P;
}

/** What flows through the content-script pipeline (Tap → Adapter → Normalizer → Relay). */
export type Capture =
    // Layer 4: Keystrokes
    | BaseCapture<"input.keystroke", InputKeystrokePayload>
    | BaseCapture<"input.keystroke_batch", InputKeystrokeBatchPayload>
    | BaseCapture<"input.composition", InputCompositionPayload>
    // Layer 5: Mouse & Touch
    | BaseCapture<"input.click", InputClickPayload>
    | BaseCapture<"input.double_click", InputDoubleClickPayload>
    | BaseCapture<"input.context_menu", InputContextMenuPayload>
    // Layer 6: Scroll
    | BaseCapture<"input.scroll", InputScrollPayload>
    // Layer 7: Selection & Clipboard
    | BaseCapture<"input.selection", InputSelectionPayload>
    | BaseCapture<"input.copy", InputCopyPayload>
    | BaseCapture<"input.paste", InputPastePayload>
    // Layer 8: Forms
    | BaseCapture<"input.form_focus", InputFormFocusPayload>
    | BaseCapture<"input.form_change", InputFormChangePayload>
    | BaseCapture<"input.form_submit", InputFormSubmitPayload>
    // Adapter-specific
    | BaseCapture<"html.content", HTMLContentPayload>
    | BaseCapture<"file.content", FileContentPayload>
    | BaseCapture<"outlook.navigate", OutlookNavigatePayload>
    | BaseCapture<"outlook.send", OutlookSendPayload>
    | BaseCapture<"outlook.discard", OutlookDiscardPayload>;

// ── pipeline types ──────────────────────────────────────────────────

export type Teardown = () => void;

/** Base layer. Hooks into the DOM and streams Captures to a sink. */
export type Tap = (sink: (capture: Capture) => void) => Teardown;

/** Middleware. Wraps a Tap, may inject/filter/transform Captures. */
export type Adapter = (inner: Tap) => Tap;

/** Middleware. Wraps a Tap, aggregates/deduplicates Captures. */
export type Normalizer = (inner: Tap) => Tap;

/** Terminal. Wraps a Tap, forwards Captures to the service worker. */
export type Relay = (inner: Tap) => Teardown;

// ── routing ─────────────────────────────────────────────────────────

export type Route = {
    match: (url: string) => boolean;
    build: () => Teardown;
};
