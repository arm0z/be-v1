import type { Aggregator, Checkpoint } from "./types.ts";

import { dev } from "../event/dev.ts";

const STORAGE_KEY = "checkpoint";
const CHECKPOINT_EVERY_N_SEALED = 15;

export function createCheckpointer(aggregator: Aggregator) {
    let sealedSinceCheckpoint = 0;

    function save(): void {
        const cp = aggregator.snapshot();
        chrome.storage.local.set({ [STORAGE_KEY]: cp });
        dev.log("checkpoint", "checkpoint.written", "checkpoint saved", {
            sealed: cp.sealed.length,
            transitions: cp.transitions.length,
            hasOpenBundle: cp.openBundle !== null,
        });
    }

    function saveSuspend(): void {
        const cp = aggregator.snapshot();
        chrome.storage.local.set({ [STORAGE_KEY]: cp });
        dev.log(
            "checkpoint",
            "checkpoint.suspend",
            "checkpoint saved on suspend",
            {
                sealed: cp.sealed.length,
                transitions: cp.transitions.length,
                hasOpenBundle: cp.openBundle !== null,
            },
        );
    }

    async function recover(flushAndSync: () => Promise<void>): Promise<void> {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        const cp = result[STORAGE_KEY] as Checkpoint | undefined;
        if (!cp) return;

        const staleBundleSealed = cp.openBundle !== null;
        aggregator.restore(cp);
        dev.log("checkpoint", "checkpoint.recovered", "checkpoint restored", {
            sealed: cp.sealed.length,
            transitions: cp.transitions.length,
            staleBundleSealed,
        });

        await flushAndSync();

        await chrome.storage.local.remove(STORAGE_KEY);
        dev.log(
            "checkpoint",
            "checkpoint.cleared",
            "checkpoint cleared after recovery",
            {},
        );
    }

    function onBundleSealed(): void {
        sealedSinceCheckpoint++;
        if (sealedSinceCheckpoint >= CHECKPOINT_EVERY_N_SEALED) {
            sealedSinceCheckpoint = 0;
            save();
        }
    }

    return { save, saveSuspend, recover, onBundleSealed };
}
