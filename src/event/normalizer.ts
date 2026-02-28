import type { Normalizer as NormalizerFn } from "./types.ts";
import { dev } from "./dev.ts";

const KEYSTROKE_FLUSH_MS = 1_000;

/**
 * Batches rapid keydown Captures into a single "typing" Capture.
 * All other event kinds pass through immediately.
 */
export const normalizer: NormalizerFn = (inner) => {
  return (sink) => {
    let keyBuffer: string[] = [];
    let keyContext: string | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flushKeys() {
      if (keyBuffer.length === 0) return;
      const text = keyBuffer.join("");
      const capture = {
        kind: "typing",
        context: keyContext ?? "root",
        timestamp: Date.now(),
        payload: { text, length: text.length },
      };
      dev.log("normalizer", "typing", `batched ${keyBuffer.length} keystrokes`);
      sink(capture);
      keyBuffer = [];
      keyContext = null;
    }

    const teardownInner = inner((capture) => {
      if (capture.kind === "keydown") {
        const key = capture.payload.key as string;
        // Only buffer printable characters
        if (key.length === 1) {
          keyBuffer.push(key);
          keyContext = capture.context;
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = setTimeout(flushKeys, KEYSTROKE_FLUSH_MS);
          return; // absorbed — don't forward the raw keydown
        }
        // Non-printable keys (Enter, Escape, etc.) flush the buffer then pass through
        flushKeys();
      }
      sink(capture);
    });

    return () => {
      flushKeys();
      if (flushTimer) clearTimeout(flushTimer);
      teardownInner();
    };
  };
};
