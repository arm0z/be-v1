import {
    Braces,
    ChevronDown,
    ChevronUp,
    ChevronsDownUp,
    ChevronsUpDown,
    Clipboard,
    ClipboardCheck,
    Eye,
    LayoutList,
    Package,
    Trash2,
    Upload,
} from "lucide-react";
import type { Edge, Group, GroupMeta, Packet } from "@/aggregation/types";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { DevEntry } from "@/event/dev";
import { JsonTreeView } from "../components/JsonTreeView";
import { Row } from "../components/Row";
import { formatDuration, formatTime } from "../lib/format";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

function groupToMarkdown(g: Group, i: number): string {
    const lines = [`## Group #${i} — ${g.meta.sources.join(", ")}`];
    lines.push(
        `**Time:** ${formatTime(g.meta.timeRange.start)} – ${formatTime(g.meta.timeRange.end)}`,
    );
    lines.push(
        `**Duration:** ${formatDuration(g.meta.timeRange.end - g.meta.timeRange.start)}`,
    );
    lines.push(`**Bundles:** ${g.bundles.length}`);
    lines.push(`**Tabs:** ${g.meta.tabs.join(", ")}`);
    if (g.text) lines.push("", "### Activity", "", g.text);
    return lines.join("\n");
}

function CopyGroupButton({ group, index }: { group: Group; index: number }) {
    const { copied, copy } = useCopyFeedback();
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => copy(groupToMarkdown(group, index))}
                    className="text-muted-foreground"
                >
                    {copied ? (
                        <ClipboardCheck className="h-3.5 w-3.5" />
                    ) : (
                        <Clipboard className="h-3.5 w-3.5" />
                    )}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
        </Tooltip>
    );
}

function MetaRow({ meta }: { meta: GroupMeta }) {
    return (
        <div className="space-y-1">
            <Row
                label="Time"
                value={`${formatTime(meta.timeRange.start)} – ${formatTime(meta.timeRange.end)}`}
            />
            <Row
                label="Duration"
                value={formatDuration(
                    meta.timeRange.end - meta.timeRange.start,
                )}
            />
            <Row label="Idle" value={formatDuration(meta.idleMs)} />
            <Row label="Sources" value={String(meta.sources.length)} />
            <Row label="Tabs" value={meta.tabs.join(", ")} />
        </div>
    );
}

function GroupCard({
    group,
    index,
    collapsed,
    onToggle,
}: {
    group: Group;
    index: number;
    collapsed: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-3 bg-muted/20 px-4 py-2 text-sm">
                <span className="text-muted-foreground">#{index}</span>
                <span className="font-mono truncate">
                    {group.meta.sources.length === 1
                        ? group.meta.sources[0]
                        : `${group.meta.sources.length} sources`}
                </span>
                <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                    {group.bundles.length} bundles
                    <CopyGroupButton group={group} index={index} />
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                onClick={onToggle}
                                className="flex items-center rounded p-1 text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                            >
                                {collapsed ? (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                ) : (
                                    <ChevronUp className="h-3.5 w-3.5" />
                                )}
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {collapsed ? "Expand" : "Collapse"}
                        </TooltipContent>
                    </Tooltip>
                </span>
            </div>
            {!collapsed && (
                <div className="space-y-2 border-t border-border/50 px-4 py-2">
                    <MetaRow meta={group.meta} />
                    {group.meta.sources.length > 1 && (
                        <div>
                            <span className="text-xs text-muted-foreground">
                                Sources:
                            </span>
                            <div className="mt-1 flex flex-wrap gap-1">
                                {group.meta.sources.map((s) => (
                                    <span
                                        key={s}
                                        className="rounded-full border border-border/50 px-2 py-0.5 font-mono text-[11px]"
                                    >
                                        {s}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    {group.text && (
                        <pre className="mt-2 whitespace-pre-wrap wrap-break-word rounded bg-muted/20 p-2 text-xs text-muted-foreground/80">
                            {group.text}
                        </pre>
                    )}
                </div>
            )}
        </div>
    );
}

function EdgeRow({ edge }: { edge: Edge }) {
    return (
        <div className="flex items-center gap-2 px-4 py-1.5 text-sm">
            <span className="font-mono truncate">{edge.from}</span>
            <span className="text-muted-foreground">&rarr;</span>
            <span className="font-mono truncate">{edge.to}</span>
            <span className="ml-auto font-mono text-muted-foreground">
                w: {edge.weight}
            </span>
        </div>
    );
}

function FormattedPacket({ packet }: { packet: Packet }) {
    const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
    const allExpanded = useMemo(
        () =>
            packet.groups.length > 0 &&
            packet.groups.every((_, i) => !collapsed.has(i)),
        [packet.groups, collapsed],
    );

    const collapseAll = useCallback(() => {
        setCollapsed(new Set(packet.groups.map((_, i) => i)));
    }, [packet.groups]);

    const expandAll = useCallback(() => {
        setCollapsed(new Set());
    }, []);

    const toggle = useCallback((i: number) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(i)) next.delete(i);
            else next.add(i);
            return next;
        });
    }, []);

    const totalIdleMs = useMemo(
        () => packet.groups.reduce((sum, g) => sum + g.meta.idleMs, 0),
        [packet.groups],
    );

    return (
        <div className="space-y-5">
            {/* Packet header */}
            <div className="overflow-hidden rounded-md border">
                <div className="space-y-1 px-4 py-3">
                    <Row label="Packet ID" value={packet.id} />
                    <Row label="Created" value={formatTime(packet.createdAt)} />
                    <Row label="Groups" value={String(packet.groups.length)} />
                    <Row label="Edges" value={String(packet.edges.length)} />
                    <Row label="Total Idle" value={formatDuration(totalIdleMs)} />
                </div>
            </div>

            {/* Groups */}
            <section>
                <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        Groups{" "}
                        <span className="ml-1 text-blue-400">
                            {packet.groups.length}
                        </span>
                    </h3>
                    {packet.groups.length > 0 && (
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={allExpanded ? collapseAll : expandAll}
                        >
                            {allExpanded ? (
                                <ChevronsDownUp className="h-3 w-3" />
                            ) : (
                                <ChevronsUpDown className="h-3 w-3" />
                            )}
                            {allExpanded ? "Collapse all" : "Expand all"}
                        </Button>
                    )}
                </div>
                {packet.groups.length === 0 ? (
                    <p className="text-sm text-muted-foreground/60">
                        No groups
                    </p>
                ) : (
                    <div className="space-y-2">
                        {packet.groups.map((g, i) => (
                            <GroupCard
                                key={g.id}
                                group={g}
                                index={i}
                                collapsed={collapsed.has(i)}
                                onToggle={() => toggle(i)}
                            />
                        ))}
                    </div>
                )}
            </section>

            {/* Edges */}
            <section>
                <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Edges{" "}
                    <span className="ml-1 text-blue-400">
                        {packet.edges.length}
                    </span>
                </h3>
                {packet.edges.length === 0 ? (
                    <p className="text-sm text-muted-foreground/60">No edges</p>
                ) : (
                    <div className="divide-y divide-border/50 overflow-hidden rounded-md border">
                        {packet.edges.map((e, i) => (
                            <EdgeRow
                                key={`${e.from}\0${e.to}\0${i}`}
                                edge={e}
                            />
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

// ── Main Component ───────────────────────────────────────────────────

export function PacketInspector({
    entries,
    onSend,
}: {
    entries: DevEntry[];
    onSend?: (msg: { type: string }) => void;
}) {
    const [format, setFormat] = useState("formatted");
    const [clearedAt, setClearedAt] = useState(0);

    // Find the last flushed packet from dev entries (after last clear)
    const packet = useMemo(() => {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (i < clearedAt) break;
            const e = entries[i];
            if (
                (e.event === "sync.flush" || e.event === "pack.flushed") &&
                e.data
            ) {
                const data = e.data as { packet?: Packet };
                if (data.packet) return data.packet;
            }
        }
        return null;
    }, [entries, clearedAt]);

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3">
                {onSend ? (
                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => onSend({ type: "sync.peek" })}
                            className="text-muted-foreground"
                        >
                            <Eye className="size-3" />
                            Peek
                        </Button>
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => onSend({ type: "sync.flush" })}
                            className="text-muted-foreground"
                        >
                            <Package className="size-3" />
                            Flush
                        </Button>
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => onSend({ type: "sync.send" })}
                            className="text-muted-foreground"
                        >
                            <Upload className="size-3" />
                            Send
                        </Button>
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setClearedAt(entries.length)}
                            className="text-muted-foreground"
                        >
                            <Trash2 className="size-3" />
                            Clear
                        </Button>
                    </div>
                ) : (
                    <span />
                )}
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
            </div>
            <div className="dev-scrollbar min-h-0 flex-1 overflow-auto p-4">
                {!packet && (
                    <p className="text-sm text-muted-foreground">
                        No packet yet — click Flush to pack current bundles.
                    </p>
                )}
                {!!packet && format === "json" && (
                    <JsonTreeView data={packet} />
                )}
                {!!packet && format === "formatted" && (
                    <FormattedPacket packet={packet} />
                )}
            </div>
        </div>
    );
}
