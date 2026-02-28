import type { Adapter } from "../types.ts";
import { dev } from "../dev.ts";

const SNAPSHOT_INTERVAL = 60_000;

/** Wraps any Tap and injects periodic HTML snapshots (deduped by hash). */
export const htmlAdapter: Adapter = (inner) => {
  return (sink) => {
    let lastHash: string | null = null;
    let lastClickTarget: string | null = null;

    const teardownInner = inner((capture) => {
      if (capture.kind === "click") {
        lastClickTarget = (capture.payload.selector as string) ?? null;
      }
      sink(capture);
    });

    const interval = setInterval(() => {
      const html = document.documentElement.outerHTML;
      const hash = simpleHash(html);
      if (hash === lastHash) return;
      lastHash = hash;

      const capture = {
        kind: "viewport.snapshot",
        context: "root",
        timestamp: Date.now(),
        payload: { html, lastClickTarget },
      };
      dev.log("adapter", "viewport.snapshot", "html snapshot", {
        hashChanged: true,
      });
      sink(capture);
    }, SNAPSHOT_INTERVAL);

    return () => {
      clearInterval(interval);
      teardownInner();
    };
  };
};

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}
