import type { Route } from "./types.ts";
import { fileAdapter } from "./adapters/file.ts";
import { htmlAdapter } from "./adapters/html.ts";
import { normalizer } from "./normalizer.ts";
import { outlookAdapter } from "./adapters/outlook.ts";
import { relay } from "./relay.ts";
import { tap } from "./tap.ts";

/** Ordered list of Routes. First match wins. Last entry is the catch-all. */
export const registry: Route[] = [
    {
        match: (url) =>
            /outlook\.office\.com\/mail\//.test(url) ||
            /outlook\.(com|live\.com)\/mail\//.test(url),
        build: () => relay(normalizer(outlookAdapter(tap()))),
    },
    {
        match: (url) => url.startsWith("file://"),
        build: () => relay(normalizer(fileAdapter(tap()))),
    },
    {
        // catch-all: generic web
        match: () => true,
        // TODO: remove htmlAdapter and add other whitelisted
        build: () => relay(normalizer(htmlAdapter(tap()))),
    },
];
