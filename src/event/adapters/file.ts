import type { Adapter } from "../types.ts";
import { dev } from "../dev.ts";

/** Reads the text content of file:// pages and emits a file.content Capture on start. */
export const fileAdapter: Adapter = (inner) => {
  return (sink) => {
    const teardownInner = inner(sink);

    const text = document.body?.innerText ?? "";
    if (text) {
      const capture = {
        kind: "file.content",
        context: "root",
        timestamp: Date.now(),
        payload: {
          url: window.location.href,
          text: text.slice(0, 50_000),
          length: text.length,
        },
      };
      dev.log("adapter", "file.content", "file content read", {
        length: text.length,
      });
      sink(capture);
    }

    return teardownInner;
  };
};
