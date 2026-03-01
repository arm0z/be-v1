import type { Packet } from "../aggregation/types.ts";
import { dev } from "../event/dev.ts";

/* TODO: update to production URL */
const SYNC_URL = import.meta.env.DEV
    ? "http://localhost:5000/api/v1/extension/sync"
    : "/api/v1/extension/sync";
const RETRY_QUEUE_KEY = "retryQueue";
const RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RETRY_MAX_ENTRIES = 50;

// ── Sender ──────────────────────────────────────────────────

async function getAuthToken(): Promise<string> {
    // TODO: implement real token retrieval
    return "";
}

/** Sends a packet to the server. Throws on failure. */
async function sendPacket(packet: Packet): Promise<void> {
    const token = await getAuthToken();
    const res = await fetch(SYNC_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(packet),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    dev.log("sync", "sync.sent", `packet ${packet.id} synced`, {
        packetId: packet.id,
    });
}

export async function sync(packet: Packet): Promise<void> {
    try {
        await sendPacket(packet);
    } catch (err) {
        dev.log(
            "sync",
            "sync.failed",
            `packet ${packet.id} failed, queued for retry`,
            { packetId: packet.id, error: String(err) },
        );
        await pushToRetryQueue(packet);
    }
}

// ── Retry Queue ─────────────────────────────────────────────

type RetryEntry = {
    packet: Packet;
    queuedAt: number;
};

async function pushToRetryQueue(packet: Packet): Promise<void> {
    const stored = await chrome.storage.local.get(RETRY_QUEUE_KEY);
    const queue = (stored[RETRY_QUEUE_KEY] as RetryEntry[] | undefined) ?? [];
    queue.push({ packet, queuedAt: Date.now() });
    if (queue.length > RETRY_MAX_ENTRIES) {
        queue.splice(0, queue.length - RETRY_MAX_ENTRIES);
    }
    await chrome.storage.local.set({ [RETRY_QUEUE_KEY]: queue });
}

export async function drainRetryQueue(): Promise<void> {
    const stored = await chrome.storage.local.get(RETRY_QUEUE_KEY);
    const queue = (stored[RETRY_QUEUE_KEY] as RetryEntry[] | undefined) ?? [];
    if (queue.length === 0) return;

    // Clear the queue immediately — we'll re-queue failures
    await chrome.storage.local.remove(RETRY_QUEUE_KEY);

    const now = Date.now();
    for (let i = 0; i < queue.length; i++) {
        const entry = queue[i];
        if (now - entry.queuedAt > RETRY_MAX_AGE_MS) {
            dev.log(
                "sync",
                "retry.expired",
                `packet ${entry.packet.id} expired, dropping`,
                { packetId: entry.packet.id, age: now - entry.queuedAt },
            );
            continue;
        }
        try {
            await sendPacket(entry.packet);
        } catch {
            // Network is down — re-queue remaining entries and bail
            const remaining = queue.slice(i);
            await chrome.storage.local.set({ [RETRY_QUEUE_KEY]: remaining });
            dev.log(
                "sync",
                "retry.bailed",
                `retry failed, re-queued ${remaining.length} entries`,
            );
            return;
        }
    }
}
