import {
    Braces,
    CircleOff,
    LayoutList,
    ListRestart,
    Play,
    RefreshCw,
    Trash2,
    X,
} from "lucide-react";
import type { Packet } from "@/aggregation/types";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { JsonTreeView } from "../components/JsonTreeView";
import { Row } from "../components/Row";
import { formatDuration, formatTime } from "../lib/format";
import { toast } from "sonner";

// ── Types ───────────────────────────────────────────────────────

type RetryEntry = { packet: Packet; queuedAt: number };

// ── Formatted view ──────────────────────────────────────────────

function EntryCard({ entry, index }: { entry: RetryEntry; index: number }) {
    const age = formatDuration(Date.now() - entry.queuedAt);
    return (
        <div className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-3 bg-muted/20 px-4 py-2 text-sm">
                <span className="text-muted-foreground">#{index}</span>
                <span className="font-mono">{entry.packet.id}</span>
                <span className="ml-auto text-muted-foreground">
                    {age} ago
                </span>
            </div>
            <div className="space-y-1 border-t border-border/50 px-4 py-2">
                <Row
                    label="Groups"
                    value={String(entry.packet.groups.length)}
                />
                <Row label="Edges" value={String(entry.packet.edges.length)} />
                <Row label="Queued At" value={formatTime(entry.queuedAt)} />
                <Row
                    label="Created At"
                    value={formatTime(entry.packet.createdAt)}
                />
            </div>
        </div>
    );
}

function FormattedRetryQueue({ queue }: { queue: RetryEntry[] }) {
    return (
        <div className="space-y-5">
            <div className="flex items-center justify-between rounded-md border p-3 text-sm">
                <span className="text-muted-foreground">Entries</span>
                <span className="font-mono">{queue.length}</span>
            </div>
            <section>
                <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Queued Packets{" "}
                    <span className="ml-1 text-blue-400">{queue.length}</span>
                </h3>
                <div className="space-y-2">
                    {queue.map((entry, i) => (
                        <EntryCard
                            key={`${entry.packet.id}-${entry.queuedAt}`}
                            entry={entry}
                            index={i}
                        />
                    ))}
                </div>
            </section>
        </div>
    );
}

// ── Storage hook ────────────────────────────────────────────────

function useRetryQueueStorage() {
    const [queue, setQueue] = useState<RetryEntry[]>([]);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(() => {
        if (!chrome.storage?.local) {
            setLoading(false);
            return;
        }
        setLoading(true);
        chrome.storage.local
            .get("retryQueue")
            .then((result) => {
                const loaded =
                    (result.retryQueue as RetryEntry[] | undefined) ?? [];
                setQueue(loaded);
                setLoading(false);
                toast(
                    loaded.length
                        ? `${loaded.length} entries loaded`
                        : "Retry queue is empty",
                    {
                        icon: loaded.length ? (
                            <ListRestart className="size-4" />
                        ) : (
                            <CircleOff className="size-4" />
                        ),
                    },
                );
            })
            .catch((err: unknown) => {
                setLoading(false);
                toast("Failed to load retry queue — " + String(err), {
                    icon: <X className="size-4" />,
                });
            });
    }, []);

    const clear = useCallback(() => {
        if (!chrome.storage?.local) return;
        chrome.storage.local
            .remove("retryQueue")
            .then(() => {
                setQueue([]);
                toast("Retry queue cleared", {
                    icon: <Trash2 className="size-4" />,
                });
            })
            .catch((err: unknown) => {
                toast("Failed to clear retry queue — " + String(err), {
                    icon: <X className="size-4" />,
                });
            });
    }, []);

    useEffect(() => {
        refresh();

        if (!chrome.storage?.onChanged) return;

        const onChange = (
            changes: { [key: string]: chrome.storage.StorageChange },
            area: string,
        ) => {
            if (area !== "local" || !("retryQueue" in changes)) return;
            setQueue(
                (changes.retryQueue.newValue as RetryEntry[] | undefined) ?? [],
            );
        };
        chrome.storage.onChanged.addListener(onChange);
        return () => chrome.storage.onChanged.removeListener(onChange);
    }, [refresh]);

    return { queue, loading, refresh, clear };
}

// ── Main Component ──────────────────────────────────────────────

export function RetryQueueInspector({
    onSend,
}: {
    onSend?: (msg: { type: string }) => void;
}) {
    const [format, setFormat] = useState("formatted");
    const { queue, loading, refresh, clear } = useRetryQueueStorage();

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
                <div className="flex items-center gap-1">
                    {onSend && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="xs"
                                    onClick={() =>
                                        onSend({ type: "sync.drain_retry" })
                                    }
                                    className="text-muted-foreground"
                                >
                                    <Play className="size-3" />
                                    Drain
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Retry sending queued packets
                            </TooltipContent>
                        </Tooltip>
                    )}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={refresh}
                                className="text-muted-foreground"
                            >
                                <RefreshCw />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Refresh</TooltipContent>
                    </Tooltip>
                </div>
                {queue.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                        {queue.length} {queue.length === 1 ? "entry" : "entries"}
                    </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                    <Tabs value={format} onValueChange={setFormat}>
                        <TabsList className="h-auto border border-border bg-popover/80 p-0.5 backdrop-blur-sm">
                            <TabsTrigger
                                value="formatted"
                                className="h-auto px-2 py-0.5 text-xs"
                            >
                                <LayoutList className="size-3" />
                                Formatted
                            </TabsTrigger>
                            <TabsTrigger
                                value="json"
                                className="h-auto px-2 py-0.5 text-xs"
                            >
                                <Braces className="size-3" />
                                JSON
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={clear}
                                className="text-muted-foreground"
                                disabled={queue.length === 0}
                            >
                                <Trash2 />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Clear queue</TooltipContent>
                    </Tooltip>
                </div>
            </div>
            <div className="dev-scrollbar min-h-0 flex-1 overflow-auto p-4">
                {loading && (
                    <p className="text-sm text-muted-foreground">Loading...</p>
                )}
                {!loading && queue.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                        Retry queue is empty.
                    </p>
                )}
                {!loading && queue.length > 0 && format === "json" && (
                    <JsonTreeView data={queue} />
                )}
                {!loading && queue.length > 0 && format === "formatted" && (
                    <FormattedRetryQueue queue={queue} />
                )}
            </div>
        </div>
    );
}
