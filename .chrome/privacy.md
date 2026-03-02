# Chrome Web Store — Permission Justifications

## Single purpose description

Automatically tracks attorney browsing activity across websites and generates billable time entries for the Hourglass legal billing platform.

---

## Permission justifications

### alarms

Hourglass uses chrome.alarms to schedule two time-based sync triggers:

1. A periodic alarm fires every 2 hours to flush accumulated activity data (bundles and navigation graphs) to the Hourglass server, ensuring no tracked work is lost even during long sessions.

2. An idle alarm fires 10 minutes after the user leaves the browser (all tabs lose focus), triggering an off-browser sync so that the session's work data is safely delivered before the service worker is suspended.

These alarms are essential to reliable data delivery — without them, tracked billable time could be lost if the browser closes or the service worker is killed.

### idle

Hourglass uses chrome.idle to detect when the user is away from the keyboard and mouse (idle detection threshold: 60 seconds). This allows the extension to distinguish active work time from idle time within each tracked session. For legal billing, this distinction is critical — attorneys must report accurate active work time, not inflated wall-clock time that includes periods of inactivity. The idle state changes (active, idle, locked) are recorded alongside other activity data so that generated time entries reflect genuine billable effort.

### storage

Hourglass uses chrome.storage.local for two purposes:

1. Checkpointing — the extension periodically saves its in-memory aggregator state (open bundles, sealed bundles, navigation transitions) to local storage. If the service worker is killed by Chrome or the browser crashes, this checkpoint allows full recovery of tracked work on restart, preventing loss of billable time data.

2. Retry queue — when network delivery of a data packet fails, the packet is persisted to local storage with exponential backoff metadata. On the next startup or sync cycle, queued packets are retried. This ensures no attorney work data is lost due to transient network issues.

### tabs

Hourglass uses chrome.tabs to track which tab the attorney is actively working in. Specifically:

1. tab.onCreated / tab.onRemoved — records when tabs are opened and closed to define session boundaries and associate captured activity with the correct tab.

2. tab.onActivated — detects when the user switches between tabs, triggering source transitions in the bundler so that time is attributed to the correct website/task.

3. tab.onUpdated — detects page title changes (used to label time entries with meaningful descriptions) and audible state changes (tracks whether media is playing in a tab).

Accurate tab-level attribution is essential for legal billing — attorneys often work across dozens of tabs simultaneously and each tab's time must be tracked separately.

### webNavigation

Hourglass uses chrome.webNavigation to detect page navigation events:

1. onCompleted — fires when a page finishes loading, allowing the extension to record the URL and title of each page visit. This creates the navigation graph that groups related work into coherent time entries (e.g., researching across multiple court record pages).

2. onHistoryStateUpdated — detects single-page application (SPA) navigations where the URL changes without a full page load. Many modern legal tools (Westlaw, LexisNexis, court e-filing systems) are SPAs, so without this listener the extension would miss navigations and under-report distinct work activities.

### downloads

Hourglass uses chrome.downloads.onChanged to detect when file downloads complete. In legal work, downloading court filings, case documents, contracts, and exhibits is a common billable activity. Recording download events (filename, URL, MIME type, size) allows the extension to include document retrieval in generated time entries, giving attorneys a more complete and accurate record of their work.

### windows

Hourglass uses chrome.windows to track window-level focus and lifecycle:

1. onFocusChanged — detects when the user switches between browser windows or leaves the browser entirely (WINDOW_ID_NONE). This is critical for accurate active-tab tracking on multi-monitor setups, which are standard in law offices. Without this, the extension cannot determine which tab is actually being viewed.

2. onCreated / onRemoved — records window lifecycle for session structure, ensuring time tracking starts and stops correctly when windows open and close.

### Host permissions

Host permissions are restricted to Hourglass-operated servers where collected activity data is sent for time entry generation. No data is sent to any other server.

- *.hourglass.law — the Hourglass platform and all law firm tenant instances (app.hourglass.law, namanhowell.hourglass.law, summitlaw.hourglass.law, gblaw.hourglass.law, etc.)
- hourglass.bpmlaw.com, hourglass.pregodonnell.com — law firm custom domain tenants
- localhost, 127.0.0.1 — local development only

The content script runs on all URLs to capture browsing activity across all websites, but captured data is only transmitted to the Hourglass servers listed above.

### Content scripts — `<all_urls>`

The content script is injected into all URLs for these reasons:

1. Attorneys access thousands of different websites during legal work — court records systems (PACER, state e-filing portals), legal databases (Westlaw, LexisNexis, Fastcase), government sites, client portals, case management systems, research sites, regulatory websites, opposing counsel sites, and more. It is impossible to predict or enumerate all domains attorneys will use.

2. Legal billing compliance requires tracking ALL work time, not just time on pre-approved sites. If an attorney researches a case on an obscure state court website not in our approved list, that time must still be tracked and billed. Missing even a single site means incomplete and potentially non-compliant billing records.

3. The Hourglass product is designed to expand coverage to more legal websites and different legal work patterns over time. Broad URL access allows us to scale the extension without requiring repeated permission updates and re-reviews for each new legal site category.

The content script collects URL, page title, and time spent on all websites. Content scraping (page text and structure) is collected only on whitelisted legal websites, where it is used to generate descriptive time entry narratives.

---

## Data usage disclosures

### Collected data types

- **Web history** — URLs visited and time spent, used to generate billable time entries.
- **User activity** — clicks, keystrokes (redacted), scroll position, form interactions — used to distinguish active work from passive viewing and to produce descriptive billing narratives.
- **Website content** — page text and structure from whitelisted legal sites only, used to generate accurate time entry descriptions.

### Not collected

- **Personally identifiable information** — no names, addresses, or IDs are collected by the extension itself.
- **Financial/payment information** — not collected.
- **Authentication information** — passwords and credentials are never captured; form fields containing sensitive data are redacted.
- **Health information** — not collected.
- **Location** — not collected.

### Certifications

- User data is not sold or transferred to third parties outside of the approved use case (generating legal time entries for the user's own firm).
- User data is not used for purposes unrelated to the extension's single purpose.
- User data is not used to determine creditworthiness or for lending purposes.

### No remote code

The extension does not use remote code. All JavaScript is bundled in the extension package at build time.
