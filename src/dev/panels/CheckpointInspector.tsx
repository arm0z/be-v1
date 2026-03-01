import {
    Braces,
    CircleOff,
    HardDrive,
    LayoutList,
    RefreshCw,
    Save,
    Trash2,
    X,
} from "lucide-react";
import type { Bundle, Checkpoint, Transition } from "@/aggregation/types";
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

function SourceLabel({ source }: { source: string }) {
    return <span className="font-mono">{source}</span>;
}

function FormattedCheckpoint({
    cp,
    age,
}: {
    cp: Checkpoint;
    age: string;
}) {
    return (
        <div className="space-y-5">
            {/* Saved At */}
            <div className="flex items-center justify-between rounded-md border p-3 text-sm">
                <span className="text-muted-foreground">Saved At</span>
                <span className="font-mono">{formatTime(cp.savedAt)}</span>
            </div>

            {/* Age */}
            <div className="flex items-center justify-between rounded-md border p-3 text-sm">
                <span className="text-muted-foreground">Age</span>
                <span className="font-mono">{age}</span>
            </div>

            {/* Active Source */}
            <div className="flex items-center justify-between rounded-md border p-3 text-sm">
                <span className="text-muted-foreground">Active Source</span>
                {cp.activeSource ? (
                    <SourceLabel source={cp.activeSource} />
                ) : (
                    <span className="font-mono">—</span>
                )}
            </div>

            {/* Open Bundle */}
            <section>
                <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Open Bundle
                </h3>
                {cp.openBundle ? (
                    <BundleCard bundle={cp.openBundle} index="open" open />
                ) : (
                    <p className="text-sm text-muted-foreground/60">None</p>
                )}
            </section>

            {/* Sealed Bundles */}
            <section>
                <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Sealed Bundles{" "}
                    <span className="ml-1 text-blue-400">
                        {cp.sealed.length}
                    </span>
                </h3>
                {cp.sealed.length === 0 ? (
                    <p className="text-sm text-muted-foreground/60">None</p>
                ) : (
                    <div className="space-y-2">
                        {cp.sealed.map((b, i) => (
                            <BundleCard
                                key={`${b.source}-${b.startedAt}`}
                                bundle={b}
                                index={i}
                            />
                        ))}
                    </div>
                )}
            </section>

            {/* Transitions */}
            <TransitionList transitions={cp.transitions} />
        </div>
    );
}

function BundleCard({
    bundle,
    index,
    open: isOpen,
}: {
    bundle: Bundle;
    index: number | string;
    open?: boolean;
}) {
    return (
        <div className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-3 bg-muted/20 px-4 py-2 text-sm">
                {isOpen && <span className="text-green-400">●</span>}
                {!isOpen && (
                    <span className="text-muted-foreground">
                        #{String(index)}
                    </span>
                )}
                <SourceLabel source={bundle.source} />
                <span className="ml-auto text-muted-foreground">
                    {bundle.captures.length} captures
                </span>
            </div>
            <div className="space-y-1 border-t border-border/50 px-4 py-2">
                <Row
                    label="Span"
                    value={`${formatTime(bundle.startedAt)} – ${bundle.endedAt ? formatTime(bundle.endedAt) : "..."}`}
                />
                {bundle.endedAt && (
                    <Row
                        label="Duration"
                        value={formatDuration(
                            bundle.endedAt - bundle.startedAt,
                        )}
                    />
                )}
                {bundle.text && (
                    <pre className="mt-2 whitespace-pre-wrap wrap-break-word rounded bg-muted/20 p-2 text-xs text-muted-foreground/80">
                        {bundle.text}
                    </pre>
                )}
            </div>
        </div>
    );
}

function TransitionList({ transitions }: { transitions: Transition[] }) {
    return (
        <section>
            <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                Transitions{" "}
                <span className="ml-1 text-blue-400">{transitions.length}</span>
            </h3>
            {transitions.length === 0 ? (
                <p className="text-sm text-muted-foreground/60">None</p>
            ) : (
                <div className="divide-y divide-border/50 overflow-hidden rounded-md border text-sm">
                    {transitions.map((t, i) => (
                        <div
                            key={`${t.from}\0${t.to}\0${t.ts}\0${i}`}
                            className="flex items-center gap-2 px-4 py-1.5"
                        >
                            <SourceLabel source={t.from} />
                            <span className="text-muted-foreground">
                                &rarr;
                            </span>
                            <SourceLabel source={t.to} />
                            <span className="ml-auto font-mono text-muted-foreground">
                                dwell: {t.dwellMs}ms, at: {formatTime(t.ts)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}

// ── Storage hook ────────────────────────────────────────────────────

// This hook reads directly from chrome.storage.local rather than through
// DevContext/port. This is intentional: the checkpoint is a raw storage
// artifact, not a streamed event. Consequence: checkpoint data is not
// subject to the DevHub filter/replay mechanism. The chrome.storage.onChanged
// listener provides live reactivity independently.
function useCheckpointStorage() {
    const [cp, setCp] = useState<Checkpoint | null>(null);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(() => {
        if (!chrome.storage?.local) {
            setLoading(false);
            return;
        }
        setLoading(true);
        chrome.storage.local
            .get("checkpoint")
            .then((result) => {
                const loaded = (result.checkpoint as Checkpoint | undefined) ?? null;
                setCp(loaded);
                setLoading(false);
                toast(loaded ? "Checkpoint loaded" : "No checkpoint found", {
                    icon: loaded ? <HardDrive className="size-4" /> : <CircleOff className="size-4" />,
                });
            })
            .catch((err: unknown) => {
                setLoading(false);
                toast("Failed to load checkpoint — " + String(err), {
                    icon: <X className="size-4" />,
                });
            });
    }, []);

    const clear = useCallback(() => {
        if (!chrome.storage?.local) return;
        chrome.storage.local
            .remove("checkpoint")
            .then(() => {
                setCp(null);
                toast("Checkpoint cleared", {
                    icon: <Trash2 className="size-4" />,
                });
            })
            .catch((err: unknown) => {
                toast("Failed to clear checkpoint — " + String(err), {
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
            if (area !== "local" || !("checkpoint" in changes)) return;
            setCp((changes.checkpoint.newValue as Checkpoint | undefined) ?? null);
        };
        chrome.storage.onChanged.addListener(onChange);
        return () => chrome.storage.onChanged.removeListener(onChange);
    }, [refresh]);

    return { cp, loading, refresh, clear };
}

// ── Main Component ──────────────────────────────────────────────────

export function CheckpointInspector({
    onSend,
}: {
    onSend?: (msg: { type: string }) => void;
}) {
    const [format, setFormat] = useState("formatted");
    const { cp, loading, refresh, clear } = useCheckpointStorage();

    const [age, setAge] = useState<string | null>(null);
    useEffect(() => {
        if (!cp) {
            setAge(null);
            return;
        }
        const update = () => setAge(formatDuration(Date.now() - cp.savedAt));
        update();
        const id = setInterval(update, 30_000);
        return () => clearInterval(id);
    }, [cp]);

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
                                        onSend({ type: "checkpoint.save" })
                                    }
                                    className="text-muted-foreground"
                                >
                                    <Save className="size-3" />
                                    Save
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Save checkpoint now
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
                {cp && (
                    <span className="text-xs text-muted-foreground">
                        {cp.sealed.length} sealed, {cp.transitions.length}{" "}
                        transitions, {age} ago
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
                                disabled={!cp}
                            >
                                <Trash2 />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Clear checkpoint</TooltipContent>
                    </Tooltip>
                </div>
            </div>
            <div className="dev-scrollbar min-h-0 flex-1 overflow-auto p-4">
                {loading && (
                    <p className="text-sm text-muted-foreground">Loading...</p>
                )}
                {!loading && !cp && (
                    <p className="text-sm text-muted-foreground">
                        No checkpoint in storage.
                    </p>
                )}
                {!loading && cp && format === "json" && (
                    <JsonTreeView data={cp} />
                )}
                {!loading && cp && format === "formatted" && (
                    <FormattedCheckpoint cp={cp} age={age ?? "0s"} />
                )}
            </div>
        </div>
    );
}
