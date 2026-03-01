import type { Capture } from "../event/types.ts";
import type { DevChannel, DevEntry, DevFilter } from "../event/dev.ts";
import { dev } from "../event/dev.ts";
import { createAggregator } from "../aggregation/index.ts";
import { createPacker } from "../aggregation/packer.ts";
import { createCheckpointer } from "../aggregation/checkpoint.ts";
import { sync, drainRetryQueue } from "../sync/index.ts";

const aggregator = createAggregator();
const packer = createPacker(aggregator);
const checkpointer = createCheckpointer(aggregator);

// ── Sync constants ──────────────────────────────────────────

const SYNC_PERIODIC_MINUTES = 120; // 2 hours
const SYNC_IDLE_MINUTES = 10; // 10 minutes off-browser

// ── Active Tab Tracking (tabStates) ─────────────────────────

const tabStates = new Map<
    number,
    { url: string; title: string; visible: boolean }
>();

let previousActiveTabId: number | null = null;

function getActiveTab() {
    for (const [tabId, state] of tabStates.entries()) {
        if (state.visible) return { tabId, ...state };
    }
    return null;
}

function onActiveTabChanged(): void {
    const active = getActiveTab();
    const newTabId = active?.tabId ?? null;
    if (newTabId === previousActiveTabId) return;
    previousActiveTabId = newTabId;

    if (active) {
        aggregator.setActiveTab(String(active.tabId), active.url);
        chrome.alarms.clear("sync-idle");
        dev.log("sync", "idle.cancelled", "sync-idle alarm cancelled");
    } else {
        aggregator.setActiveTab(null);
        chrome.alarms.create("sync-idle", {
            delayInMinutes: SYNC_IDLE_MINUTES,
        });
        dev.log(
            "sync",
            "idle.armed",
            `sync-idle alarm set (${SYNC_IDLE_MINUTES}m)`,
        );
    }
}

async function updateActiveTabFromApi(): Promise<void> {
    const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
    });

    if (!tab?.id) return;

    // Mark all existing tabs as not visible
    for (const [id, state] of tabStates.entries()) {
        if (state.visible) {
            tabStates.set(id, { ...state, visible: false });
        }
    }

    // Set the active tab
    tabStates.set(tab.id, {
        url: tab.url ?? tab.pendingUrl ?? "",
        title: tab.title ?? "",
        visible: true,
    });

    onActiveTabChanged();
}

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
        {
            type: "tab.created",
            timestamp: Date.now(),
            payload: {
                url: tab.url ?? "",
                title: tab.title ?? "",
                openerTabId: tab.openerTabId
                    ? String(tab.openerTabId)
                    : undefined,
            },
        },
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
        {
            type: "tab.closed",
            timestamp: Date.now(),
            payload: {
                windowId: removeInfo.windowId,
                isWindowClosing: removeInfo.isWindowClosing,
            },
        },
        String(tabId),
    );
    tabStates.delete(tabId);
    onActiveTabChanged();
});

// Layer 2 tab tracking — Chrome Tabs API
chrome.tabs.onActivated.addListener(() => updateActiveTabFromApi());
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        for (const [id, state] of tabStates.entries()) {
            if (state.visible) {
                tabStates.set(id, { ...state, visible: false });
            }
        }
        onActiveTabChanged();
    } else {
        updateActiveTabFromApi();
    }
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
            {
                type: "nav.completed",
                timestamp: Date.now(),
                payload: {
                    url: details.url,
                    title: tab?.title ?? "",
                    transitionType: "",
                },
            },
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
            {
                type: "nav.spa",
                timestamp: Date.now(),
                payload: { url: details.url, title: tab?.title ?? "" },
            },
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
            {
                type: "nav.title_changed",
                timestamp: Date.now(),
                payload: { title: changeInfo.title, url: tab.url ?? "" },
            },
            String(tabId),
        );
    }

    // Layer 9: Media — audible state
    if (changeInfo.audible !== undefined) {
        dev.log("tap", "media.audio", "audible state changed", {
            audible: changeInfo.audible,
        });
        aggregator.ingestSignal(
            {
                type: "media.audio",
                timestamp: Date.now(),
                payload: { audible: changeInfo.audible },
            },
            String(tabId),
        );
    }
});

// ── Visibility (content-script Page Visibility API) ─────────

chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type !== "page:visibility") return;
    const numericTabId = sender.tab?.id;
    const tabId = String(numericTabId ?? "unknown");

    // Update tabStates from content script (Layer 1)
    if (numericTabId != null) {
        if (msg.visible) {
            // Mark all others not visible first
            for (const [id, state] of tabStates.entries()) {
                if (state.visible && id !== numericTabId) {
                    tabStates.set(id, { ...state, visible: false });
                }
            }
        }
        tabStates.set(numericTabId, {
            url: msg.url ?? "",
            title: msg.title ?? "",
            visible: msg.visible,
        });
        onActiveTabChanged();
    }

    aggregator.ingestSignal(
        {
            type: "attention.visible",
            timestamp: Date.now(),
            payload: {
                visible: msg.visible,
                url: msg.url ?? "",
                title: msg.title ?? "",
            },
        },
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
            {
                type: "media.download",
                timestamp: Date.now(),
                payload: {
                    filename: item.filename,
                    url: item.url,
                    mime: item.mime,
                    size: item.totalBytes,
                    state: delta.state!.current!,
                },
            },
            "unknown",
        );
    });
});

// ── Sync triggers ───────────────────────────────────────────

async function flushAndSync(): Promise<void> {
    const packet = packer.flush();
    if (!packet) return;
    dev.log(
        "sync",
        "packet.ready",
        `packet ${packet.id} ready (${packet.groups.length} groups)`,
        {
            packetId: packet.id,
            groups: packet.groups.length,
            edges: packet.edges.length,
        },
    );
    await sync(packet);
}

// Periodic alarm — repeats every 2 hours
chrome.alarms.create("sync-periodic", {
    periodInMinutes: SYNC_PERIODIC_MINUTES,
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "sync-periodic" || alarm.name === "sync-idle") {
        flushAndSync();
        // Reset the periodic alarm after an idle flush so we
        // don't get a redundant flush shortly after the user returns
        if (alarm.name === "sync-idle") {
            chrome.alarms.create("sync-periodic", {
                periodInMinutes: SYNC_PERIODIC_MINUTES,
            });
        }
    }
});

// Register seal callback for periodic checkpointing
aggregator.onSeal(() => checkpointer.onBundleSealed());

// Last-chance checkpoint + flush on suspend
chrome.runtime.onSuspend.addListener(() => {
    checkpointer.saveSuspend();
    flushAndSync();
});

// Recovery on startup, then drain retry queue
checkpointer.recover(() => flushAndSync()).then(() => drainRetryQueue());

// ── DevHub (dev mode only) ──────────────────────────────────

if (import.meta.env.DEV) {
    const LOG_BUFFER_SIZE = 10_000;
    const logs: DevEntry[] = [];
    const ports: Set<chrome.runtime.Port> = new Set();

    type DevMessage =
        | { type: "entry"; entry: DevEntry }
        | { type: "replay"; entries: DevEntry[] }
        | { type: "filter"; filter: DevFilter };

    type DevCommand =
        | {
              type: "setChannelFilter";
              channels: Partial<Record<DevChannel, boolean>>;
          }
        | { type: "setEventFilter"; events: Partial<Record<string, boolean>> }
        | { type: "sync.flush" }
        | { type: "sync.send" }
        | { type: "checkpoint.save" }
        | { type: "sync.drain_retry" }
        | { type: "state.reset" };

    const filter: DevFilter = {
        channels: {
            tap: true,
            adapter: true,
            normalizer: true,
            relay: true,
            aggregator: true,
            packer: true,
            navigation: true,
            sync: true,
            checkpoint: true,
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

        // replay buffered logs as a single bulk message so the panel
        // handles it in one state update instead of 10,000 individual ones
        port.postMessage({
            type: "replay",
            entries: logs.slice(),
        } satisfies DevMessage);

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
            if (msg.type === "sync.flush") {
                const packet = packer.flush();
                dev.log(
                    "sync",
                    "sync.flush",
                    packet ? `packet ${packet.id}` : "nothing to flush",
                    { packet: packet ?? null },
                );
            }
            if (msg.type === "sync.send") {
                dev.log("sync", "sync.send", "flush & sync triggered");
                flushAndSync();
            }
            if (msg.type === "checkpoint.save") {
                checkpointer.save();
                // checkpointer.save() logs its own checkpoint.written event
            }
            if (msg.type === "sync.drain_retry") {
                dev.log("sync", "sync.drain_retry", "draining retry queue");
                drainRetryQueue();
            }
            if (msg.type === "state.reset") {
                logs.length = 0;
                packer.flush(); // seal + drain aggregator
                chrome.storage.local.remove(["checkpoint", "retryQueue"]);
                dev.log("sync", "state.reset", "all state cleared");
            }
        });
    });

    // Service worker's own dev.log calls go directly to receive(),
    // avoiding a sendMessage round-trip to itself.
    dev.log = (channel, event, message, data?) => {
        receive({ channel, event, timestamp: Date.now(), message, data });
    };
}
