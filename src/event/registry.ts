import type { Route } from "./types.ts";
import { tap } from "./tap.ts";
import { htmlAdapter } from "./adapters/html.ts";
import { outlookAdapter } from "./adapters/outlook.ts";
import { fileAdapter } from "./adapters/file.ts";
import { normalizer } from "./normalizer.ts";
import { relay } from "./relay.ts";

/** Ordered list of Routes. First match wins. Last entry is the catch-all. */
export const registry: Route[] = [
  {
    match: (url) => /outlook\.(com|live\.com)/.test(url),
    build: () => relay(normalizer(outlookAdapter(tap()))),
  },
  {
    match: (url) => url.startsWith("file://"),
    build: () => relay(normalizer(fileAdapter(tap()))),
  },
  {
    // catch-all: generic web
    match: () => true,
    build: () => relay(normalizer(htmlAdapter(tap()))),
  },
];
