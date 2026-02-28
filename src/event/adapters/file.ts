// TODO: impl

import type { Adapter, FileContentPayload } from "../types.ts";
import { dev } from "../dev.ts";

export const FILE_CONTENT = "file.content" as const;
export type { FileContentPayload };

/** Reads the text content of file:// pages and emits a file.content Capture on start. */
export const fileAdapter: Adapter = (inner) => {
	return (sink) => {
		const teardownInner = inner(sink);

		const text = document.body?.innerText ?? "";
		if (text) {
			dev.log("adapter", FILE_CONTENT, "file content read", {
				length: text.length,
			});
			sink({
				type: FILE_CONTENT,
				ts: Date.now(),
				context: "root",
				payload: {
					url: window.location.href,
					text: text.slice(0, 50_000),
					length: text.length,
				} satisfies FileContentPayload,
			});
		}

		return teardownInner;
	};
};
