// TODO: impl

import type { Adapter, SnapshotViewportPayload } from "../types.ts";
import { dev } from "../dev.ts";

export const SNAPSHOT_VIEWPORT = "snapshot.viewport" as const;
export type { SnapshotViewportPayload };

const SNAPSHOT_INTERVAL = 60_000;

/** Wraps any Tap and injects periodic HTML snapshots (deduped by hash). */
export const htmlAdapter: Adapter = (inner) => {
	return (sink) => {
		let lastHash: string | null = null;
		let lastClickTarget: string | null = null;

		const teardownInner = inner((capture) => {
			if (capture.type === "input.click") {
				lastClickTarget = capture.payload.target.selector;
			}
			sink(capture);
		});

		const interval = setInterval(() => {
			const html = document.documentElement.outerHTML;
			const hash = simpleHash(html);
			if (hash === lastHash) return;
			lastHash = hash;

			dev.log("adapter", SNAPSHOT_VIEWPORT, "html snapshot", {
				hashChanged: true,
			});
			sink({
				type: SNAPSHOT_VIEWPORT,
				ts: Date.now(),
				context: "root",
				payload: {
					generator: "htmlAdapter",
					trigger: "mutation",
					url: window.location.href,
					title: document.title,
					viewport: {
						width: window.innerWidth,
						height: window.innerHeight,
						scrollY: window.scrollY,
						scrollPercent:
							document.documentElement.scrollHeight > 0
								? window.scrollY /
									document.documentElement.scrollHeight
								: 0,
					},
					content: html,
				} satisfies SnapshotViewportPayload,
			});
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
