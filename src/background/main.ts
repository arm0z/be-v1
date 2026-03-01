import type { Capture, Signal } from "../event/types.ts";
import type { DevChannel, DevEntry } from "../event/dev.ts";
import { dev } from "../event/dev.ts";
import { createAggregator } from "../aggregation/index.ts";

const aggregator = createAggregator();

// Seed activeTabPerWindow for windows that already exist
chrome.windows.getAll({ populate: false }, (windows) => {
    for (const w of windows) {
        if (w.id === undefined) continue;
        chrome.tabs.query({ active: true, windowId: w.id }, (tabs) => {
            if (tabs[0]?.id !== undefined) {
                aggregator.onTabActivated(String(tabs[0].id), w.id!);
            }
        });
    }
});

// ── Receive Captures from the Event Layer (port-based) ──────

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "capture") return;

    const tabId = String(port.sender?.tab?.id ?? "unknown");

    port.onMessage.addListener((message) => {
        if (message.type !== "capture") return;
        const capture: Capture = message.payload;
        if (!capture?.type) {
            console.warn(
                "[capture] malformed message",
                JSON.stringify(message),
            );
            return;
        }
        aggregator.ingest(capture, tabId);
    });
});

// ── Layer 1: Session Structure ──────────────────────────────

chrome.windows.onCreated.addListener((window) => {
    dev.log("tap", "window.created", "window created", {
        bounds: {
            top: window.top ?? 0,
            left: window.left ?? 0,
            width: window.width ?? 0,
            height: window.height ?? 0,
        },
    });
});

chrome.windows.onRemoved.addListener((windowId) => {
    dev.log("tap", "window.closed", "window closed", { windowId });
});

chrome.windows.onBoundsChanged.addListener((window) => {
    dev.log("tap", "window.resized", "window resized", {
        bounds: {
            top: window.top ?? 0,
            left: window.left ?? 0,
            width: window.width ?? 0,
            height: window.height ?? 0,
        },
    });
});

chrome.tabs.onCreated.addListener((tab) => {
    const tabId = String(tab.id ?? "unknown");
    dev.log("tap", "tab.created", "tab created", {
        url: tab.url ?? "",
        title: tab.title ?? "",
        openerTabId: tab.openerTabId ? String(tab.openerTabId) : undefined,
    });
    aggregator.ingestSignal(
        { type: "tab.created", timestamp: Date.now(), payload: { url: tab.url ?? "", title: tab.title ?? "", openerTabId: tab.openerTabId ? String(tab.openerTabId) : undefined } },
        tabId,
    );
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    dev.log("tap", "tab.closed", "tab closed", {
        tabId,
        windowId: removeInfo.windowId,
        isWindowClosing: removeInfo.isWindowClosing,
    });
    aggregator.ingestSignal(
        { type: "tab.closed", timestamp: Date.now(), payload: { windowId: removeInfo.windowId, isWindowClosing: removeInfo.isWindowClosing } },
        String(tabId),
    );
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
    dev.log("tap", "tab.moved", "tab moved", {
        tabId,
        fromIndex: moveInfo.fromIndex,
        toIndex: moveInfo.toIndex,
    });
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    dev.log("tap", "tab.transferred", "tab detached", {
        tabId,
        fromWindowId: detachInfo.oldWindowId,
    });
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    dev.log("tap", "tab.transferred", "tab attached", {
        tabId,
        toWindowId: attachInfo.newWindowId,
    });
});

// ── Layer 2: Navigation ─────────────────────────────────────

chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId !== 0) return; // top frame only
    chrome.tabs.get(details.tabId, (tab) => {
        dev.log("tap", "nav.completed", "navigation completed", {
            url: details.url,
            title: tab?.title ?? "",
            transitionType: "",
        });
        aggregator.ingestSignal(
            { type: "nav.completed", timestamp: Date.now(), payload: { url: details.url, title: tab?.title ?? "", transitionType: "" } },
            String(details.tabId),
        );
    });
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    chrome.tabs.get(details.tabId, (tab) => {
        dev.log("tap", "nav.spa", "SPA navigation", {
            url: details.url,
            title: tab?.title ?? "",
        });
        aggregator.ingestSignal(
            { type: "nav.spa", timestamp: Date.now(), payload: { url: details.url, title: tab?.title ?? "" } },
            String(details.tabId),
        );
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.title) {
        dev.log("tap", "nav.title_changed", "title changed", {
            title: changeInfo.title,
            url: tab.url ?? "",
        });
        aggregator.ingestSignal(
            { type: "nav.title_changed", timestamp: Date.now(), payload: { title: changeInfo.title, url: tab.url ?? "" } },
            String(tabId),
        );
    }

    // Layer 9: Media — audible state
    if (changeInfo.audible !== undefined) {
        dev.log("tap", "media.audio", "audible state changed", {
            audible: changeInfo.audible,
        });
        aggregator.ingestSignal(
            { type: "media.audio", timestamp: Date.now(), payload: { audible: changeInfo.audible } },
            String(tabId),
        );
    }
});

// ── Layer 3: Attention ──────────────────────────────────────

chrome.tabs.onActivated.addListener((activeInfo) => {
    aggregator.onTabActivated(String(activeInfo.tabId), activeInfo.windowId);
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        dev.log("tap", "attention.active", "tab activated", {
            active: true,
            url: tab?.url ?? "",
            title: tab?.title ?? "",
        });
        aggregator.ingestSignal(
            { type: "attention.active", timestamp: Date.now(), payload: { active: true, url: tab?.url ?? "", title: tab?.title ?? "" } },
            String(activeInfo.tabId),
        );
    });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
    aggregator.onWindowFocusChanged(windowId);
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        dev.log("tap", "attention.visible", "browser lost focus", {
            visible: false,
            url: "",
            title: "",
        });
        aggregator.ingestSignal(
            { type: "attention.visible", timestamp: Date.now(), payload: { visible: false, url: "", title: "" } },
            "unknown",
        );
    } else {
        chrome.tabs.query({ active: true, windowId }, (tabs) => {
            const tab = tabs[0];
            dev.log("tap", "attention.visible", "browser gained focus", {
                visible: true,
                url: tab?.url ?? "",
                title: tab?.title ?? "",
            });
            aggregator.ingestSignal(
                { type: "attention.visible", timestamp: Date.now(), payload: { visible: true, url: tab?.url ?? "", title: tab?.title ?? "" } },
                String(tab?.id ?? "unknown"),
            );
        });
    }
});

chrome.idle.onStateChanged.addListener((state) => {
    dev.log("tap", "attention.idle", `idle state: ${state}`, { state });
});

// ── Content-script visibility (Page Visibility API) ─────────

chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type !== "page:visibility") return;
    const tabId = String(sender.tab?.id ?? "unknown");
    dev.log("tap", "attention.visible", msg.visible ? "page became visible" : "page became hidden", {
        visible: msg.visible,
        url: msg.url ?? "",
        title: msg.title ?? "",
        tabId,
    });
    aggregator.ingestSignal(
        { type: "attention.visible", timestamp: Date.now(), payload: { visible: msg.visible, url: msg.url ?? "", title: msg.title ?? "" } },
        tabId,
    );
});

// ── Layer 9: Media & Downloads ──────────────────────────────

chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state) return;
    chrome.downloads.search({ id: delta.id }, (items) => {
        const item = items[0];
        if (!item) return;
        dev.log("tap", "media.download", "download state changed", {
            filename: item.filename,
            url: item.url,
            mime: item.mime,
            size: item.totalBytes,
            state: delta.state!.current!,
        });
        aggregator.ingestSignal(
            { type: "media.download", timestamp: Date.now(), payload: { filename: item.filename, url: item.url, mime: item.mime, size: item.totalBytes, state: delta.state!.current! } },
            "unknown",
        );
    });
});

// ── DevHub (dev mode only) ──────────────────────────────────

if (import.meta.env.DEV) {
    const LOG_BUFFER_SIZE = 10_000;
    const logs: DevEntry[] = [];
    const ports: Set<chrome.runtime.Port> = new Set();

    type DevFilter = {
        channels: Record<DevChannel, boolean>;
        events: Record<string, boolean>;
    };

    type DevMessage =
        | { type: "entry"; entry: DevEntry }
        | { type: "filter"; filter: DevFilter };

    type DevCommand =
        | {
              type: "setChannelFilter";
              channels: Partial<Record<DevChannel, boolean>>;
          }
        | { type: "setEventFilter"; events: Partial<Record<string, boolean>> };

    const filter: DevFilter = {
        channels: {
            tap: true,
            adapter: true,
            normalizer: true,
            relay: true,
            aggregator: true,
            graph: true,
            sync: true,
            persistence: true,
        },
        events: {},
    };

    function receive(entry: DevEntry): void {
        if (!filter.channels[entry.channel]) return;
        if (entry.event && filter.events[entry.event] === false) return;

        logs.push(entry);
        if (logs.length > LOG_BUFFER_SIZE) logs.shift();

        // also log to the service worker console for easy debugging
        console.log(
            `[dev:${entry.channel}]`,
            entry.event ?? "",
            entry.message,
            entry.data ?? "",
        );

        for (const port of ports) {
            port.postMessage({ type: "entry", entry } satisfies DevMessage);
        }
    }

    // receive dev:log from content scripts AND from self (service worker)
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "dev:log") {
            receive(msg.entry);
        }
    });

    // dev page connects via chrome.runtime.connect({ name: "dev" })
    chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== "dev") return;
        ports.add(port);
        port.onDisconnect.addListener(() => ports.delete(port));

        // replay buffered logs so the panel isn't empty on connect
        for (const entry of logs) {
            port.postMessage({ type: "entry", entry } satisfies DevMessage);
        }

        port.postMessage({
            type: "filter",
            filter,
        } satisfies DevMessage);

        port.onMessage.addListener((msg: DevCommand) => {
            if (msg.type === "setChannelFilter") {
                Object.assign(filter.channels, msg.channels);
                for (const p of ports) {
                    p.postMessage({
                        type: "filter",
                        filter,
                    } satisfies DevMessage);
                }
            }
            if (msg.type === "setEventFilter") {
                Object.assign(filter.events, msg.events);
                for (const p of ports) {
                    p.postMessage({
                        type: "filter",
                        filter,
                    } satisfies DevMessage);
                }
            }
        });
    });

    // Service worker's own dev.log calls go directly to receive(),
    // avoiding a sendMessage round-trip to itself.
    dev.log = (channel, event, message, data?) => {
        receive({ channel, event, timestamp: Date.now(), message, data });
    };
}
