import type { Adapter } from "../types.ts";
import { dev } from "../dev.ts";

/** Filters out transient routes, only forwards events on specific email views. */
export const outlookAdapter: Adapter = (inner) => {
  return (sink) => {
    const isEmailView = () =>
      /\/mail\//.test(window.location.pathname) &&
      window.location.pathname !== "/mail/";

    const teardownInner = inner((capture) => {
      if (!isEmailView()) {
        dev.log("adapter", "filtered", "dropped capture (transient route)", {
          kind: capture.kind,
        });
        return;
      }
      sink(capture);
    });

    return teardownInner;
  };
};
