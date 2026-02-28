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

export interface TabMovedPayload {
    fromIndex: number;
    toIndex: number;
}

export interface TabTransferredPayload {
    fromWindowId: number;
    toWindowId: number;
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

export interface AttentionActivePayload {
    active: boolean;
    url: string;
    title: string;
}

export interface AttentionVisiblePayload {
    visible: boolean;
    url: string;
    title: string;
}

export interface AttentionMousePresencePayload {
    present: boolean;
}

export interface AttentionIdlePayload {
    state: "active" | "idle" | "locked";
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

// ── discriminated union ─────────────────────────────────────────────

/** Content-script capture: flows through the pipeline before the service worker stamps it. */
interface BaseCapture<T extends string, P> {
    type: T;
    ts: number;
    context: string;
    payload: P;
}

/** Full stamped event: service worker adds tabId, windowId, source. */
interface BaseEvent<T extends string, P> {
    ts: number;
    tabId: string;
    windowId: number;
    context: string;
    source: string;
    type: T;
    payload: P;
}

/** What flows through the content-script pipeline (Tap → Adapter → Normalizer → Relay). */
export type Capture =
    // Layer 4: Keystrokes
    | BaseCapture<"input.keystroke", InputKeystrokePayload>
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
    | BaseCapture<"file.content", FileContentPayload>;

/** All events in the system — content-script captures get stamped by the service worker. */
export type SessionEvent =
    // Layer 1: Session Structure
    | BaseEvent<"window.created", WindowCreatedPayload>
    | BaseEvent<"window.closed", WindowClosedPayload>
    | BaseEvent<"window.resized", WindowResizedPayload>
    | BaseEvent<"tab.created", TabCreatedPayload>
    | BaseEvent<"tab.closed", TabClosedPayload>
    | BaseEvent<"tab.moved", TabMovedPayload>
    | BaseEvent<"tab.transferred", TabTransferredPayload>
    // Layer 2: Navigation
    | BaseEvent<"nav.completed", NavCompletedPayload>
    | BaseEvent<"nav.spa", NavSpaPayload>
    | BaseEvent<"nav.title_changed", NavTitleChangedPayload>
    // Layer 3: Attention
    | BaseEvent<"attention.active", AttentionActivePayload>
    | BaseEvent<"attention.visible", AttentionVisiblePayload>
    | BaseEvent<"attention.mouse_presence", AttentionMousePresencePayload>
    | BaseEvent<"attention.idle", AttentionIdlePayload>
    // Layer 4: Keystrokes
    | BaseEvent<"input.keystroke", InputKeystrokePayload>
    | BaseEvent<"input.composition", InputCompositionPayload>
    // Layer 5: Mouse & Touch
    | BaseEvent<"input.click", InputClickPayload>
    | BaseEvent<"input.double_click", InputDoubleClickPayload>
    | BaseEvent<"input.context_menu", InputContextMenuPayload>
    // Layer 6: Scroll
    | BaseEvent<"input.scroll", InputScrollPayload>
    // Layer 7: Selection & Clipboard
    | BaseEvent<"input.selection", InputSelectionPayload>
    | BaseEvent<"input.copy", InputCopyPayload>
    | BaseEvent<"input.paste", InputPastePayload>
    // Layer 8: Forms
    | BaseEvent<"input.form_focus", InputFormFocusPayload>
    | BaseEvent<"input.form_change", InputFormChangePayload>
    | BaseEvent<"input.form_submit", InputFormSubmitPayload>
    // Layer 9: Media & Downloads
    | BaseEvent<"media.audio", MediaAudioPayload>
    | BaseEvent<"media.download", MediaDownloadPayload>
    // Adapter-specific
    | BaseEvent<"html.content", HTMLContentPayload>
    | BaseEvent<"file.content", FileContentPayload>;

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
