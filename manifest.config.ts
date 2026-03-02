import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
    manifest_version: 3,
    name: pkg.name,
    version: pkg.version,
    icons: {
        16: "public/icon/default-16.png",
        32: "public/icon/default-32.png",
        48: "public/icon/default-48.png",
        64: "public/icon/default-64.png",
    },
    action: {
        default_icon: {
            16: "public/icon/default-16.png",
            32: "public/icon/default-32.png",
            48: "public/icon/default-48.png",
            64: "public/icon/default-64.png",
        },
        default_popup: "src/popup/index.html",
    },
    permissions: [
        "alarms",
        "idle",
        "storage",
        "tabs",
        "webNavigation",
        "downloads",
        "windows",
    ],
    host_permissions: [
        "https://*.hourglass.law/*",
        "https://hourglass.bpmlaw.com/*",
        "https://hourglass.pregodonnell.com/*",
        "http://localhost/*",
        "http://127.0.0.1/*",
    ],
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
    side_panel: {
        default_path: "src/popup/index.html",
    },
    options_page: "src/dev/index.html",
});
