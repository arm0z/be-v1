# How to Track the Active Browser Tab in a Chrome Extension (Manifest V3)

This document explains how to build a Chrome extension that knows which tab the user is currently looking at — not just which tab is "active" in Chrome's tab bar, but which tab is actually **visible on screen**. This matters because a tab can be "active" in Chrome while the user is in a completely different application (VS Code, Slack, a terminal, etc.).

## The Problem

Chrome's built-in `chrome.tabs` API can tell you which tab is selected, but it cannot tell you whether the user is actually looking at Chrome. If the user switches to VS Code, Chrome still reports the same "active" tab — it has no concept of OS-level window visibility.

To solve this, we combine two things:

1. **Content scripts** running inside each page that use the browser's Page Visibility API and focus/blur events to detect OS-level visibility
2. **A service worker** that collects these signals and maintains a central registry of which tab is truly visible

## Example Output

Here's what the service worker console looks like in real-time. Each line is logged from `service-worker.ts` when a visibility change occurs:

```log
2026-03-01T05:16:52.297Z Active Chrome tab: {tabId: 607215597, url: 'https://claude.ai/recents', title: 'Claude', visible: true}
2026-03-01T05:16:53.360Z Active Chrome tab: null
2026-03-01T05:16:53.361Z Active Chrome tab: {tabId: 607215599, url: 'https://hourglass-l6.sentry.io/issues/?end=2026-02…ct=4510948157685760&start=2026-02-25T17%3A01%3A00', title: 'Feed — hourglass-l6 — Sentry', visible: true}
2026-03-01T05:16:54.539Z Active Chrome tab: null
2026-03-01T05:16:54.540Z Active Chrome tab: {tabId: 607215597, url: 'https://claude.ai/recents', title: 'Claude', visible: true}
2026-03-01T05:16:56.526Z Active Chrome tab: null
2026-03-01T05:16:59.094Z Active Chrome tab: {tabId: 607215597, url: 'https://claude.ai/recents', title: 'Claude', visible: true}
2026-03-01T05:16:59.174Z Active Chrome tab: null
2026-03-01T05:16:59.182Z Active Chrome tab: null
2026-03-01T05:16:59.187Z Active Chrome tab: {tabId: 607215599, url: 'https://hourglass-l6.sentry.io/issues/?end=2026-02…ct=4510948157685760&start=2026-02-25T17%3A01%3A00', title: 'Feed — hourglass-l6 — Sentry', visible: true}
2026-03-01T05:16:59.818Z Active Chrome tab: null
2026-03-01T05:17:00.403Z Active Chrome tab: null
2026-03-01T05:17:08.412Z Active Chrome tab: {tabId: 607215601, url: 'https://claude.ai/recents', title: 'Claude', visible: true}
2026-03-01T05:17:12.176Z Active Chrome tab: null
2026-03-01T05:17:13.664Z Active Chrome tab: {tabId: 607215603, url: 'https://hourglass-l6.sentry.io/issues/', title: 'Sentry', visible: true}
2026-03-01T05:17:17.236Z Active Chrome tab: null
2026-03-01T05:17:17.237Z Active Chrome tab: {tabId: 607215601, url: 'https://claude.ai/recents', title: 'Claude', visible: true}
2026-03-01T05:17:18.360Z Active Chrome tab: null
2026-03-01T05:17:18.360Z Active Chrome tab: {tabId: 607215603, url: 'https://hourglass-l6.sentry.io/issues/?end=2026-02…ct=4510948157685760&start=2026-02-25T17%3A01%3A00', title: 'Feed — hourglass-l6 — Sentry', visible: true}
2026-03-01T05:17:24.247Z Active Chrome tab: null
2026-03-01T05:17:27.698Z Active Chrome tab: {tabId: 607215603, url: 'https://hourglass-l6.sentry.io/issues/?end=2026-02…ct=4510948157685760&start=2026-02-25T17%3A01%3A00', title: 'Feed — hourglass-l6 — Sentry', visible: true}
2026-03-01T05:17:31.527Z Active Chrome tab: null
2026-03-01T05:17:31.528Z Active Chrome tab: {tabId: 607215601, url: 'https://claude.ai/recents', title: 'Claude', visible: true}
2026-03-01T05:17:32.548Z Active Chrome tab: null
```

**Reading the output:**

- `{tabId: ..., url: ..., title: ..., visible: true}` — the user is looking at this tab right now
- `null` — the user left Chrome entirely (switched to another app, minimized the browser, etc.)
- A `null` followed immediately by a new tab object means the user switched tabs (the old one goes hidden, the new one becomes visible)

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│                         BROWSER (OS Level)                       │
│                                                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐         │
│  │   Tab A       │  │   Tab B       │  │   Tab C       │         │
│  │ (claude.ai)   │  │ (sentry.io)   │  │ (github.com)  │         │
│  │               │  │               │  │               │         │
│  │ Content Script│  │ Content Script│  │ Content Script│         │
│  │  - visibility │  │  - visibility │  │  - visibility │         │
│  │  - focus/blur │  │  - focus/blur │  │  - focus/blur │         │
│  └──────┬────────┘  └──────┬────────┘  └──────┬────────┘         │
│         │                  │                  │                  │
│         │   chrome.runtime.sendMessage()      │                  │
│         │   {type: "PAGE_VISIBILITY_CHANGED"} │                  │
│         ▼                  ▼                  ▼                  │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │                   Service Worker                        │     │
│  │                                                         │     │
│  │   tabStates = Map<tabId, {url, title, visible}>         │     │
│  │                                                         │     │
│  │   getActiveTab() → first visible entry or null          │     │
│  └─────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

Each content script detects visibility changes for its own page and sends a message to the service worker. The service worker maintains a `Map` of all tab states and exposes a `getActiveTab()` function.

---

## Project Structure

```log
my-extension/
├── manifest.config.ts          # Manifest V3 definition
├── vite.config.ts              # Build config (Vite + CRXJS)
├── tsconfig.json               # TypeScript config
├── package.json
├── public/
│   └── logo.png                # Extension icon
└── src/
    ├── background/
    │   └── service-worker.ts   # Central tab state registry
    └── content/
        └── main.ts             # Visibility detection per page
```

---

## Step-by-Step Implementation

### 1. Manifest (permissions & entry points)

**`manifest.config.ts`**

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
    background: {
        service_worker: "src/background/service-worker.ts",
        type: "module",
    },
    content_scripts: [
        {
            js: ["src/content/main.ts"],
            matches: ["https://*/*"],
        },
    ],
    permissions: ["tabs"],
});
```

**What each part does:**

| Field                        | Purpose                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `manifest_version: 3`        | Required for modern Chrome extensions                    |
| `background.service_worker`  | Points to the service worker file that manages tab state |
| `background.type: "module"`  | Allows using ES module `import`/`export` syntax          |
| `content_scripts[0].js`      | The script injected into every page to detect visibility |
| `content_scripts[0].matches` | `"https://*/*"` means inject on every HTTPS page         |
| `permissions: ["tabs"]`      | Required to access `sender.tab.id` in message handlers   |

> **Note:** The `matches` pattern `"https://*/*"` only covers HTTPS pages. If you need HTTP too, add `"http://*/*"`. Chrome internal pages (`chrome://`, `chrome-extension://`) cannot be injected into.

If you want to also use a static `manifest.json` instead of the CRXJS dynamic config:

```json
{
    "manifest_version": 3,
    "name": "Active Tab Tracker",
    "version": "1.0.0",
    "background": {
        "service_worker": "service-worker.js",
        "type": "module"
    },
    "content_scripts": [
        {
            "js": ["content.js"],
            "matches": ["https://*/*"]
        }
    ],
    "permissions": ["tabs"]
}
```

---

### 2. Content Script — Visibility Detection

**`src/content/main.ts`**

This is the script that runs inside every web page. Its job is to detect whether the user is actually looking at this page and tell the service worker.

```ts
// ============================================
// PAGE VISIBILITY TRACKING
// ============================================

/**
 * Track the last known visibility state to avoid duplicate messages.
 * Without this, rapid focus/blur events would flood the service worker.
 */
let lastVisibilityState: boolean | null = null;

/**
 * Send visibility updates to the service worker.
 * This runs in the page context and gets OS-level visibility changes
 * that the service worker cannot detect on its own.
 */
function sendVisibilityUpdate(isVisible: boolean) {
    // Don't send if state hasn't changed
    if (lastVisibilityState === isVisible) {
        return;
    }

    lastVisibilityState = isVisible;

    chrome.runtime
        .sendMessage({
            type: "PAGE_VISIBILITY_CHANGED",
            visible: isVisible,
            url: window.location.href,
            title: document.title,
            timestamp: Date.now(),
        })
        .catch((err) => {
            // Service worker might not be ready yet, that's OK
            console.debug("Could not send visibility update:", err);
        });
}

/**
 * Page Visibility API — detects when tab is hidden/visible.
 * This fires when:
 * - The user switches to another tab
 * - The user minimizes the browser
 * - The user switches to another application (VS Code, Slack, etc.)
 * - The OS triggers a window change (e.g., lock screen)
 */
document.addEventListener("visibilitychange", () => {
    const isVisible = document.visibilityState === "visible";
    sendVisibilityUpdate(isVisible);
});

/**
 * Window focus/blur — additional signal for edge cases.
 * The visibility API covers most scenarios, but focus/blur catches
 * some situations where a page might technically be "visible" but
 * the user is interacting with a different window.
 */
window.addEventListener("focus", () => {
    sendVisibilityUpdate(true);
});

window.addEventListener("blur", () => {
    sendVisibilityUpdate(false);
});

/**
 * Send initial state when the content script loads.
 * Without this, the service worker wouldn't know about tabs that
 * were already open when the extension was installed/reloaded.
 */
sendVisibilityUpdate(document.visibilityState === "visible");
```

#### How the three event listeners work together

| Event              | When it fires                 | Detects                                        |
| ------------------ | ----------------------------- | ---------------------------------------------- |
| `visibilitychange` | Tab becomes hidden or visible | Tab switching, browser minimize, app switching |
| `focus`            | Page gains keyboard focus     | Clicking back into the browser window          |
| `blur`             | Page loses keyboard focus     | Clicking away from the browser                 |

The `visibilitychange` event does the heavy lifting. The `focus`/`blur` events are a safety net for edge cases.

#### The message shape

```ts
{
    type: "PAGE_VISIBILITY_CHANGED",  // Identifies this message type
    visible: boolean,                  // true = user is looking at this tab
    url: string,                       // window.location.href
    title: string,                     // document.title
    timestamp: number,                 // Date.now() in milliseconds
}
```

#### Deduplication

The `lastVisibilityState` variable prevents sending duplicate messages. Without it, rapid `visibilitychange` + `blur` events (which often fire together) would result in redundant messages to the service worker.

```ts
// First call: lastVisibilityState is null, sends message, sets to false
sendVisibilityUpdate(false);

// Second call: lastVisibilityState is already false, returns early
sendVisibilityUpdate(false);  // no-op
```

#### Error handling

The `.catch()` on `chrome.runtime.sendMessage()` handles a common scenario: the service worker might not be running yet (it's event-driven in MV3 and can be idle). If the message fails, we silently log it and move on — the next visibility change will try again.

---

### 3. Service Worker — Central State Registry

**`src/background/service-worker.ts`**

This is the brain of the system. It receives visibility messages from all content scripts and maintains a single source of truth for which tab is currently active.

```ts
console.log("[Service Worker] Background script initialized");

/**
 * Central registry of tab visibility states.
 *
 * Key:   tab ID (number) — unique identifier assigned by Chrome
 * Value: { url, title, visible } — the latest known state for that tab
 *
 * This Map grows as the user opens tabs and shrinks as tabs are closed.
 * At any given moment, at most one entry should have visible: true.
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
 * Get the currently active tab (first visible tab) or null.
 *
 * Returns the first tab in the Map with visible: true.
 * Returns null if the user is not looking at any tracked tab
 * (e.g., they're in a different application).
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

    if (message.type === "PAGE_VISIBILITY_CHANGED") {
        const tabId = sender.tab?.id;
        if (!tabId) return;

        // Update this tab's state in the registry
        tabStates.set(tabId, {
            url: message.url,
            title: message.title,
            visible: message.visible,
        });

        // Log the currently active tab
        const activeTab = getActiveTab();
        console.log(timestamp, "Active Chrome tab:", activeTab);
    }
});

/**
 * Clean up closed tabs.
 * Without this, the Map would grow forever and getActiveTab() might
 * return data for a tab that no longer exists.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
    const timestamp = new Date().toISOString();

    tabStates.delete(tabId);
    const activeTab = getActiveTab();
    console.log(timestamp, "Active Chrome tab:", activeTab);
});
```

#### The `tabStates` Map

This is the core data structure. It maps Chrome tab IDs to their current state:

```log
tabStates = {
    607215597 => { url: "https://claude.ai/recents",   title: "Claude",   visible: false },
    607215599 => { url: "https://sentry.io/issues/...", title: "Sentry",   visible: true  },
    607215601 => { url: "https://github.com/...",       title: "GitHub",   visible: false },
}
```

#### The `getActiveTab()` function

Iterates the Map and returns the first entry where `visible: true`. In practice, only zero or one tabs should be visible at any time:

- **Returns an object** when the user is looking at a Chrome tab:

  ```ts
  { tabId: 607215599, url: "https://sentry.io/...", title: "Sentry", visible: true }
  ```

- **Returns `null`** when the user is not looking at any Chrome tab (in another app, browser minimized, etc.)

#### The message listener

```ts
chrome.runtime.onMessage.addListener((message, sender) => { ... })
```

- `message` — the object sent by `chrome.runtime.sendMessage()` in the content script
- `sender` — metadata about who sent the message, including `sender.tab.id` (the Chrome-assigned tab ID)

The listener:

1. Checks `message.type === "PAGE_VISIBILITY_CHANGED"` to filter for our messages
2. Extracts `sender.tab?.id` — the `?.` handles the case where the message didn't come from a tab
3. Updates the `tabStates` Map with the new state
4. Calls `getActiveTab()` and logs the result

#### Tab cleanup

```ts
chrome.tabs.onRemoved.addListener((tabId) => { ... })
```

When the user closes a tab, we remove it from the Map. This prevents stale data from accumulating and ensures `getActiveTab()` doesn't return a closed tab.

---

## Why `null` Appears Between Tab Switches

Looking at the example output:

```log
05:16:52.297Z Active Chrome tab: {tabId: 607215597, url: 'https://claude.ai/recents', ...}
05:16:53.360Z Active Chrome tab: null
05:16:53.361Z Active Chrome tab: {tabId: 607215599, url: 'https://hourglass-l6.sentry.io/...', ...}
```

When the user switches from Tab A to Tab B:

1. **Tab A fires `visibilitychange`** → sends `visible: false` → service worker updates Tab A → `getActiveTab()` finds no visible tabs → logs `null`
2. **Tab B fires `visibilitychange`** → sends `visible: true` → service worker updates Tab B → `getActiveTab()` finds Tab B → logs the tab object

This happens within 1ms (`.360` to `.361`). The `null` state is real — for that brief instant, no tab was visible. This is expected behavior.

When the user switches to a completely different application (e.g., VS Code), you'll see `null` with no follow-up:

```log
05:17:24.247Z Active Chrome tab: null
                                        ← user is in VS Code, silence
05:17:27.698Z Active Chrome tab: {...}  ← user returned to Chrome
```

---

## The Data Shape

The active tab object (or `null`):

```ts
type ActiveTab = {
    tabId: number;     // Chrome's internal tab ID (unique per session)
    url: string;       // Full URL including query params
    title: string;     // The page's <title> content
    visible: boolean;  // Always true (by definition, since getActiveTab filters for it)
} | null;
```

---

## Build Setup

This project uses Vite with the CRXJS plugin for hot-reload during development.

**`package.json`** (key dependencies):

```json
{
    "scripts": {
        "dev": "vite",
        "build": "vue-tsc -b && vite build"
    },
    "devDependencies": {
        "@crxjs/vite-plugin": "^2.0.3",
        "@types/chrome": "^0.1.1",
        "typescript": "~5.8.3",
        "vite": "^7.0.5"
    }
}
```

**`vite.config.ts`**:

```ts
import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./manifest.config.ts";

export default defineConfig({
    plugins: [
        crx({ manifest }),
    ],
});
```

**`tsconfig.json`** (important parts):

```json
{
    "compilerOptions": {
        "types": ["chrome"],
        "strict": true,
        "target": "es2020",
        "module": "ESNext",
        "moduleResolution": "bundler"
    }
}
```

The `"types": ["chrome"]` line gives you full TypeScript types for all `chrome.*` APIs. Install with `npm install -D @types/chrome`.

---

## Running It

```bash
# Install dependencies
npm install

# Start dev server with hot reload
npm run dev
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `dist/` folder (created by Vite)
5. Open the service worker console: click "Inspect views: service worker" on the extension card
6. Switch between tabs and apps — watch the log output

---

## Edge Cases & Limitations

### Content scripts only run on matching pages

The `matches: ["https://*/*"]` pattern means the extension only tracks HTTPS pages. Chrome internal pages (`chrome://settings`, `chrome://extensions`, the New Tab page) and `chrome-extension://` pages are **not tracked**. If the user switches to one of these pages, the last tracked tab will go to `null` with no replacement.

### Service worker lifecycle (MV3)

In Manifest V3, the service worker can be terminated by Chrome after ~30 seconds of inactivity. When it restarts, the `tabStates` Map is **empty**. The next visibility event from any content script will repopulate it. This means there can be brief gaps in tracking after an idle period.

### Multiple windows

If the user has multiple Chrome windows, multiple tabs could theoretically report `visible: true` (one per window). The current implementation returns the first one found in the Map, which is essentially arbitrary. If you need per-window tracking, you'd need to include `sender.tab.windowId` in the state.

### Rapid switching

As shown in the example output, rapid tab switches produce rapid `null` → `{tab}` sequences. Each event is processed individually. If you need to debounce this (e.g., only report a tab as "active" if the user stays on it for 500ms+), you'd add a `setTimeout` in the service worker.
