<!-- omit from toc -->
# Chrome Extension: Active Tab Navigation Tracking

This document explains how the Hourglass Chrome extension tracks which browser tab the user is currently looking at, including when they leave the browser entirely.

<!-- omit from toc -->
## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
  - [Why two layers?](#why-two-layers)
- [Required Permissions](#required-permissions)
  - [`tabs` permission](#tabs-permission)
  - [`windows` permission](#windows-permission)
  - [`webNavigation` permission](#webnavigation-permission)
  - [Content script match pattern](#content-script-match-pattern)
- [Layer 1: Content Script (All Matched Pages)](#layer-1-content-script-all-matched-pages)
  - [Detection mechanisms](#detection-mechanisms)
    - [1. Page Visibility API (`visibilitychange`)](#1-page-visibility-api-visibilitychange)
    - [2. Window focus/blur events](#2-window-focusblur-events)
    - [3. `pageshow` / bfcache restoration](#3-pageshow--bfcache-restoration)
    - [4. Initial state on load](#4-initial-state-on-load)
  - [Deduplication](#deduplication)
  - [Message format](#message-format)
- [Layer 2: Chrome Tabs API (All Pages)](#layer-2-chrome-tabs-api-all-pages)
  - [`chrome.tabs.onActivated`](#chrometabsonactivated)
  - [`chrome.windows.onFocusChanged`](#chromewindowsonfocuschanged)
  - [`updateActiveTabFromApi()`](#updateactivetabfromapi)
  - [`chrome.tabs.onRemoved`](#chrometabsonremoved)
- [Combined Behavior](#combined-behavior)
  - [How the two layers interact](#how-the-two-layers-interact)
  - [Event flow examples](#event-flow-examples)
    - [Switching from `https://github.com` to `chrome://settings`](#switching-from-httpsgithubcom-to-chromesettings)
    - [Switching from `chrome://settings` to `https://github.com`](#switching-from-chromesettings-to-httpsgithubcom)
    - [User alt-tabs to VS Code](#user-alt-tabs-to-vs-code)
    - [User returns to Chrome](#user-returns-to-chrome)
- [State Management](#state-management)
  - [The `tabStates` Map](#the-tabstates-map)
  - [`getActiveTab()`](#getactivetab)
- [Output Format](#output-format)
- [Edge Cases and Limitations](#edge-cases-and-limitations)
  - [Service worker lifecycle](#service-worker-lifecycle)
  - [Multiple windows](#multiple-windows)
  - [Race conditions between layers](#race-conditions-between-layers)
  - [Tabs that content scripts cannot reach](#tabs-that-content-scripts-cannot-reach)
  - [`tab.pendingUrl` fallback](#tabpendingurl-fallback)
- [Full Source Code](#full-source-code)
  - [`manifest.config.ts`](#manifestconfigts)
  - [`src/background/main.ts`](#srcbackgroundmaints)
  - [`src/event/visibility.ts` (visibility tracking)](#srceventvisibilityts-visibility-tracking)

---

## Overview

The extension answers one question at all times: **"What tab is the user looking at right now?"**

The answer is either:

- **A tab object** — the user is actively viewing a specific tab in Chrome.
- **`null`** — the user has left Chrome entirely (switched to another application, minimized all windows, etc.).

This is implemented using two complementary detection layers because Chrome does not provide a single API that covers all cases.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────┐
│                     Service Worker                       │
│                 (src/background/main.ts)                 │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │              tabStates: Map<number, TabState>    │    │
│  │  Stores { url, title, visible } for every known  │    │
│  │  tab. getActiveTab() returns the first visible   │    │
│  │  entry, or null if none are visible.             │    │
│  └──────────────────────────────────────────────────┘    │
│                          ▲                               │
│              ┌───────────┼───────────┐                   │
│              │                       │                   │
│     Layer 1: Messages        Layer 2: Chrome APIs        │
│     from content scripts     tabs.onActivated            │
│     (PAGE_VISIBILITY_        windows.onFocusChanged      │
│      CHANGED)                tabs.onRemoved              │
│              │                       │                   │
└──────────────┼───────────────────────┼───────────────────┘
               │                       │
    ┌──────────┴──────────┐   ┌────────┴─────────┐
    │   Content Script    │   │  Chrome Browser  │
    │(src/content/main.ts)│   │  Internal Events │
    │                     │   │                  │
    │ Runs on HTTPS pages │   │ Fires for ALL    │
    │ only. Detects OS-   │   │ tab switches     │
    │ level visibility    │   │ including        │
    │ (blur, minimize,    │   │ chrome://, NTP,  │
    │ app switch).        │   │ extensions, etc. │
    └─────────────────────┘   └──────────────────┘
```

### Why two layers?

| Scenario                                 | Content Script                 | Chrome Tabs API                      |
| ---------------------------------------- | ------------------------------ | ------------------------------------ |
| User views `https://github.com`          | Yes                            | Yes                                  |
| User switches to `chrome://settings`     | No (cannot inject)             | Yes                                  |
| User opens `chrome://newtab`             | No (cannot inject)             | Yes                                  |
| User views `chrome-extension://...` page | No (cannot inject)             | Yes                                  |
| User alt-tabs to VS Code                 | Yes (fires `visibilitychange`) | Yes (`WINDOW_ID_NONE`)               |
| User minimizes browser                   | Yes (fires `visibilitychange`) | Partial (only if window loses focus) |
| User switches tabs within same window    | Yes (fires `visibilitychange`) | Yes                                  |

Content scripts provide **OS-level visibility detection** (Page Visibility API, window focus/blur) but only work on HTTPS pages. The Chrome Tabs API works on **all pages** including privileged `chrome://` URLs but doesn't detect OS-level events like minimizing as reliably. Together they cover every scenario.

---

## Required Permissions

In `manifest.config.ts`:

```ts
permissions: ["alarms", "storage", "tabs", "webNavigation", "downloads", "windows"],
```

The navigation-relevant permissions:

### `tabs` permission

- Grants access to `tab.url` and `tab.title` properties on `chrome.tabs.query()` results.
- Without this permission, `tab.url` is `undefined` for most pages.
- Also enables `chrome.tabs.onActivated` and `chrome.tabs.onRemoved` listeners.

### `windows` permission

- Enables `chrome.windows.onFocusChanged` listener.
- This event fires with `chrome.windows.WINDOW_ID_NONE` (-1) when **all** Chrome windows lose focus, which is how we detect the user leaving the browser.

### `webNavigation` permission

- Enables `chrome.webNavigation.onCompleted` listener for tracking page navigation events.

### Content script match pattern

```ts
content_scripts: [
    {
        js: ["src/content/main.ts"],
        matches: ["<all_urls>"],
    },
],
```

- `"<all_urls>"` — injects the content script into every page the browser allows (HTTP, HTTPS, file:// with user permission).
- Chrome **forbids** content script injection into `chrome://`, `chrome-extension://`, `about:`, and `data:` URLs. This is a hard browser security restriction with no workaround.

---

## Layer 1: Content Script (All Matched Pages)

**File:** `src/content/main.ts` (visibility logic in `src/event/visibility.ts`)

The content script runs inside each matched web page and uses browser APIs that are only available in a page context. Visibility tracking is handled by `setupVisibility()` in `src/event/visibility.ts`.

### Detection mechanisms

#### 1. Page Visibility API (`visibilitychange`)

```ts
document.addEventListener("visibilitychange", () => {
    const isVisible = document.visibilityState === "visible";
    sendVisibilityUpdate(isVisible);
});
```

This fires when:

- The user switches to a different tab in the same window.
- The user minimizes the browser window.
- The user switches to a different application (alt-tab).
- The OS triggers a visibility change (e.g., another window covers Chrome).

`document.visibilityState` is either `"visible"` or `"hidden"`.

#### 2. Window focus/blur events

```ts
window.addEventListener("focus", () => {
    sendVisibilityUpdate(true);
});

window.addEventListener("blur", () => {
    sendVisibilityUpdate(false);
});
```

These catch edge cases the Visibility API might miss, such as:

- Focus moving to browser chrome (address bar, devtools) while the page is still "visible."
- Some OS-specific focus transitions.

#### 3. `pageshow` / bfcache restoration

```ts
window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
        lastState = null; // force re-send
        sendVisibilityUpdate(document.visibilityState === "visible");
    }
});
```

When a page is restored from the browser's back/forward cache (bfcache), the content script doesn't re-run but the message channel is re-established. The `pageshow` handler with `e.persisted` forces a re-send of the current visibility state.

#### 4. Initial state on load

```ts
sendVisibilityUpdate(document.visibilityState === "visible");
```

When the content script first loads on a page, it immediately reports the current visibility state so the service worker knows about the tab right away (e.g., after extension install or browser restart).

### Deduplication

```ts
let lastVisibilityState: boolean | null = null;

function sendVisibilityUpdate(isVisible: boolean) {
    if (lastVisibilityState === isVisible) {
        return;
    }
    lastVisibilityState = isVisible;
    // ... send message
}
```

Both the Visibility API and focus/blur events can fire for the same state change. The `lastVisibilityState` guard ensures only actual transitions are sent to the service worker.

### Message format

```ts
chrome.runtime.sendMessage({
    type: "page:visibility",
    visible: isVisible,        // boolean
    url: window.location.href, // full URL of the page
    title: document.title,     // page title
});
```

The `.catch()` handler silently swallows errors for cases where the service worker isn't ready yet (e.g., during extension startup).

---

## Layer 2: Chrome Tabs API (All Pages)

**File:** `src/background/main.ts`

The service worker uses Chrome extension APIs to detect tab switches that content scripts cannot observe.

### `chrome.tabs.onActivated`

```ts
chrome.tabs.onActivated.addListener(() => updateActiveTabFromApi());
```

Fires whenever the user switches to a different tab within any Chrome window. This works for **all** tab types: `https://`, `http://`, `chrome://`, `chrome-extension://`, `about:blank`, `file://`, etc.

### `chrome.windows.onFocusChanged`

```ts
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        // User left the browser entirely
        const timestamp = new Date().toISOString();
        for (const [id, state] of tabStates.entries()) {
            if (state.visible) {
                tabStates.set(id, { ...state, visible: false });
            }
        }
        console.log(timestamp, "Active Chrome tab:", null);
    } else {
        // User switched to a Chrome window (possibly from another app)
        updateActiveTabFromApi();
    }
});
```

This fires in two cases:

1. **`WINDOW_ID_NONE` (-1):** All Chrome windows have lost focus. The user has switched to another application, or minimized all Chrome windows. We mark all tabs as not visible, producing a `null` active tab. This is how we know the user is "off the browser."

2. **Any other window ID:** The user has focused a Chrome window. We query the active tab in that window.

### `updateActiveTabFromApi()`

```ts
async function updateActiveTabFromApi() {
    const timestamp = new Date().toISOString();

    const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
    });

    if (!tab?.id) {
        console.log(timestamp, "Active Chrome tab:", null);
        return;
    }

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

    const activeTab = getActiveTab();
    console.log(timestamp, "Active Chrome tab:", activeTab);
}
```

Key details:

- **`chrome.tabs.query({ active: true, lastFocusedWindow: true })`** returns the single active tab in the most recently focused window. This is the tab the user is looking at.
- **`tab.url`** is available because we have the `"tabs"` permission. Without it, this field would be `undefined` for most URLs.
- **`tab.pendingUrl`** is a fallback for tabs that are still loading (the URL is set before the page finishes loading).
- Before setting the new active tab, all existing tabs are marked `visible: false` to ensure only one tab is ever active.

### `chrome.tabs.onRemoved`

```ts
chrome.tabs.onRemoved.addListener((tabId) => {
    const timestamp = new Date().toISOString();
    tabStates.delete(tabId);
    const activeTab = getActiveTab();
    console.log(timestamp, "Active Chrome tab:", activeTab);
});
```

When a tab is closed, its entry is removed from `tabStates`. If the closed tab was the active one, `getActiveTab()` returns `null` until the next `onActivated` event fires for the new active tab.

---

## Combined Behavior

### How the two layers interact

Both layers write to the same `tabStates` Map. The content script identifies tabs by `sender.tab.id` (provided by Chrome in the message sender metadata), and the Tabs API identifies tabs by the `tab.id` from query results. These are the same numeric IDs, so both layers update the same entries.

When both layers fire for the same event (e.g., switching from one HTTPS tab to another), the Tabs API update typically arrives first (synchronous event + async query), followed by the content script messages (requires page JavaScript execution). Because both write to `tabStates`, the end result is consistent regardless of ordering.

### Event flow examples

#### Switching from `https://github.com` to `chrome://settings`

1. `tabs.onActivated` fires → `updateActiveTabFromApi()` queries the active tab → gets `chrome://settings` → logs it as active.
2. The GitHub content script fires `visibilitychange` (hidden) → sends `page:visibility` with `visible: false` → service worker updates GitHub's entry.

Result: `{ tabId: X, url: "chrome://settings", title: "Settings", visible: true }`

#### Switching from `chrome://settings` to `https://github.com`

1. `tabs.onActivated` fires → `updateActiveTabFromApi()` queries the active tab → gets GitHub → logs it as active.
2. The GitHub content script fires `visibilitychange` (visible) → sends `page:visibility` with `visible: true` → service worker updates GitHub's entry (already marked visible by the API layer).

Result: `{ tabId: Y, url: "https://github.com", title: "GitHub", visible: true }`

#### User alt-tabs to VS Code

1. `windows.onFocusChanged` fires with `WINDOW_ID_NONE` → all tabs marked not visible → logs `null`.
2. Content scripts on HTTPS pages fire `visibilitychange` (hidden) / `blur` → send `visible: false` → service worker updates entries (already marked not visible).

Result: `null`

#### User returns to Chrome

1. `windows.onFocusChanged` fires with a window ID → `updateActiveTabFromApi()` queries the active tab → logs it.
2. Content scripts on the focused HTTPS page fire `visibilitychange` (visible) / `focus` → send `visible: true`.

Result: `{ tabId: Z, url: "...", title: "...", visible: true }`

---

## State Management

### The `tabStates` Map

```ts
const tabStates = new Map<
    number,
    {
        url: string;
        title: string;
        visible: boolean;
    }
>();
```

- **Key:** Chrome tab ID (numeric, unique per tab for the browser session).
- **Value:** The last known state of that tab.
- Entries are added when a tab is first observed (via content script message or Tabs API query).
- Entries are removed only when `chrome.tabs.onRemoved` fires (tab closed).
- The `visible` field is the key piece of state — at most one tab should have `visible: true` at any time.

### `getActiveTab()`

```ts
function getActiveTab() {
    for (const [tabId, state] of tabStates.entries()) {
        if (state.visible) {
            return { tabId, ...state };
        }
    }
    return null;
}
```

Returns the first (and should be only) visible tab, or `null` if no tabs are visible. A `null` return means the user is not looking at any Chrome tab (they're in another app, all windows minimized, etc.).

---

## Output Format

Every state change is logged to the service worker console:

```log
2026-03-01T17:22:10.404Z Active Chrome tab: {tabId: 607215913, url: 'https://claude.ai/recents', title: 'Claude', visible: true}
2026-03-01T17:22:16.034Z Active Chrome tab: null
2026-03-01T17:22:18.102Z Active Chrome tab: {tabId: 607215920, url: 'chrome://newtab/', title: 'New Tab', visible: true}
```

The output object shape:

```ts
// When a tab is active
{
    tabId: number;     // Chrome's internal tab ID
    url: string;       // Full URL (including chrome:// URLs)
    title: string;     // Page title
    visible: true;     // Always true when returned by getActiveTab()
}

// When no tab is active (user left browser)
null
```

---

## Edge Cases and Limitations

### Service worker lifecycle

Chrome can suspend the service worker after ~30 seconds of inactivity. When it wakes up:

- The `tabStates` Map is **empty** (in-memory state is lost).
- The next `onActivated` or `onFocusChanged` event will repopulate it.
- Content scripts will re-send visibility updates on the next state change.

If you need persistent state, consider writing to `chrome.storage.local`.

### Multiple windows

- `chrome.tabs.query({ active: true, lastFocusedWindow: true })` returns the active tab in the **last focused** window, not all windows.
- If the user has multiple Chrome windows, only the frontmost one's active tab is tracked.
- Content scripts in background windows will report `visible: false` via the Visibility API.

### Race conditions between layers

Both layers can fire near-simultaneously for the same tab switch. Because they both write to the same Map keyed by tab ID, and the final `visible` state is the same, the end result is consistent. You may see two log lines for a single switch, but the reported active tab will be correct.

### Tabs that content scripts cannot reach

These URLs never get content script injection:

- `chrome://` (settings, extensions, flags, newtab, etc.)
- `chrome-extension://` (extension pages)
- `about:blank`, `about:newtab`
- `data:` URLs
- `file://` URLs (covered by `<all_urls>` match pattern, but user must grant file access in `chrome://extensions`)
- Chrome Web Store (`https://chrome.google.com/webstore/...` — blocked by Chrome policy)
- `view-source:` URLs

For all of these, only Layer 2 (Chrome Tabs API) provides tracking. This means we get URL and title, but no OS-level visibility granularity beyond what `windows.onFocusChanged` provides.

### `tab.pendingUrl` fallback

When a tab is navigating to a new page, `tab.url` may still reflect the old URL while `tab.pendingUrl` has the new one. The code uses `tab.url ?? tab.pendingUrl ?? ""` to prefer the committed URL but fall back to the pending one.

---

## Full Source Code

### `manifest.config.ts`

```ts
import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
    manifest_version: 3,
    name: pkg.name,
    version: pkg.version,
    icons: {
        48: "public/logo.png",
    },
    action: {
        default_icon: {
            48: "public/logo.png",
        },
        default_popup: "src/popup/index.html",
    },
    background: {
        service_worker: "src/background/main.ts",
        type: "module",
    },
    content_scripts: [
        {
            js: ["src/content/main.ts"],
            matches: ["<all_urls>"],
        },
    ],
    permissions: [
        "alarms",
        "storage",
        "tabs",
        "webNavigation",
        "downloads",
        "windows",
    ],
    host_permissions: ["http://localhost:5000/*"],
    side_panel: {
        default_path: "src/sidepanel/index.html",
    },
});
```

### `src/background/main.ts`

```ts
console.log("[Service Worker] 🚀 Background script initialized");

/**
 * Track which tabs are visible
 */
const tabStates = new Map<
    number,
    {
        url: string;
        title: string;
        visible: boolean;
    }
>();

/**
 * Get the currently active tab (first visible tab) or null
 */
function getActiveTab() {
    for (const [tabId, state] of tabStates.entries()) {
        if (state.visible) {
            return { tabId, ...state };
        }
    }
    return null;
}

/**
 * Listen for visibility updates from content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender) => {
    const timestamp = new Date().toISOString();

    if (message.type === "page:visibility") {
        const tabId = sender.tab?.id;
        if (!tabId) return;

        // Update tab state
        tabStates.set(tabId, {
            url: message.url,
            title: message.title,
            visible: message.visible,
        });

        // Log the active tab
        const activeTab = getActiveTab();
        console.log(timestamp, "Active Chrome tab:", activeTab);
    }
});

/**
 * Track active tab via Chrome API (catches chrome://, chrome-extension://, etc.
 * where content scripts can't run).
 */
async function updateActiveTabFromApi() {
    const timestamp = new Date().toISOString();

    const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
    });

    if (!tab?.id) {
        console.log(timestamp, "Active Chrome tab:", null);
        return;
    }

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

    const activeTab = getActiveTab();
    console.log(timestamp, "Active Chrome tab:", activeTab);
}

chrome.tabs.onActivated.addListener(() => updateActiveTabFromApi());
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        // User left the browser — mark all tabs not visible so getActiveTab() returns null
        const timestamp = new Date().toISOString();
        for (const [id, state] of tabStates.entries()) {
            if (state.visible) {
                tabStates.set(id, { ...state, visible: false });
            }
        }
        console.log(timestamp, "Active Chrome tab:", null);
    } else {
        // User switched to a Chrome window (possibly from another app)
        updateActiveTabFromApi();
    }
});

/**
 * Clean up closed tabs
 */
chrome.tabs.onRemoved.addListener((tabId) => {
    const timestamp = new Date().toISOString();

    tabStates.delete(tabId);
    const activeTab = getActiveTab();
    console.log(timestamp, "Active Chrome tab:", activeTab);
});
```

### `src/event/visibility.ts` (visibility tracking)

```ts
let lastState: boolean | null = null;

function send(visible: boolean): void {
    if (lastState === visible) return;
    lastState = visible;

    chrome.runtime
        .sendMessage({
            type: "page:visibility",
            visible,
            url: window.location.href,
            title: document.title,
        })
        .catch(() => {
            // Service worker might not be ready yet
        });
}

export function setupVisibility(): void {
    document.addEventListener("visibilitychange", () => {
        send(document.visibilityState === "visible");
    });

    window.addEventListener("focus", () => send(true));
    window.addEventListener("blur", () => send(false));

    // Re-send state when page is restored from bfcache
    window.addEventListener("pageshow", (e) => {
        if (e.persisted) {
            lastState = null; // force re-send
            send(document.visibilityState === "visible");
        }
    });

    // Report initial state
    send(document.visibilityState === "visible");
}
```
