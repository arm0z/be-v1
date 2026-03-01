import {
    Braces,
    ChevronDown,
    ChevronUp,
    ChevronsDownUp,
    ChevronsUpDown,
    Clipboard,
    ClipboardCheck,
    LayoutList,
    Package,
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
import { writeClipboard } from "@/lib/utils";

// ── Helpers ──────────────────────────────────────────────────────────

function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
}

// ── JSON Tree (shared with StateInspector) ──────────────────────────

type TreeReset = number;

function PrimitiveValue({ value }: { value: unknown }) {
    if (value === null)
        return <span className="text-muted-foreground italic">null</span>;
    if (typeof value === "string")
        return <span className="text-green-400">"{value}"</span>;
    if (typeof value === "number")
        return <span className="text-blue-400">{value}</span>;
    if (typeof value === "boolean")
        return <span className="text-amber-400">{String(value)}</span>;
    return <span>{String(value)}</span>;
}

function JsonNode({
    label,
    value,
    depth = 0,
    reset,
}: {
    label?: string;
    value: unknown;
    depth?: number;
    reset: TreeReset;
}) {
    const isObject = value !== null && typeof value === "object";
    const isArray = Array.isArray(value);

    const expandAll = reset % 2 === 1;
    const defaultOpen = expandAll || depth < 2;
    const [open, setOpen] = useState(defaultOpen);

    if (!isObject) {
        return (
            <div className="flex items-baseline gap-1.5 py-px">
                {label != null && (
                    <span className="text-muted-foreground shrink-0">
                        {label}:
                    </span>
                )}
                <PrimitiveValue value={value} />
            </div>
        );
    }

    const entries: [string, unknown][] = isArray
        ? value.map((v, i) => [String(i), v] as [string, unknown])
        : Object.entries(value as Record<string, unknown>);
    const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;

    if (entries.length === 0) {
        return (
            <div className="flex items-baseline gap-1.5 py-px">
                {label != null && (
                    <span className="text-muted-foreground shrink-0">
                        {label}:
                    </span>
                )}
                <span className="text-muted-foreground">
                    {isArray ? "[]" : "{}"}
                </span>
            </div>
        );
    }

    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="-ml-1 flex items-baseline gap-1.5 rounded px-1 py-px hover:bg-muted/30"
            >
                <span className="w-2.5 shrink-0 text-[10px] text-muted-foreground">
                    {open ? "▼" : "▶"}
                </span>
                {label != null && (
                    <span className="text-muted-foreground">{label}:</span>
                )}
                {!open && (
                    <span className="text-muted-foreground/60">{summary}</span>
                )}
            </button>
            {open && (
                <div className="ml-2 border-l border-border/50 pl-3">
                    {entries.map(([k, v]) => (
                        <JsonNode
                            key={k}
                            label={k}
                            value={v}
                            depth={depth + 1}
                            reset={reset}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function JsonTreeView({ data }: { data: unknown }) {
    const [reset, setReset] = useState(0);
    const collapseAll = useCallback(
        () => setReset((r) => (r % 2 === 0 ? r + 2 : r + 1)),
        [],
    );
    const expandAll = useCallback(
        () => setReset((r) => (r % 2 === 1 ? r + 2 : r + 1)),
        [],
    );

    return (
        <div className="font-mono text-sm">
            <div className="mb-3 flex items-center justify-end gap-1">
                <Button variant="ghost" size="xs" onClick={expandAll}>
                    <ChevronsUpDown className="h-3 w-3" />
                    Expand all
                </Button>
                <Button variant="ghost" size="xs" onClick={collapseAll}>
                    <ChevronsDownUp className="h-3 w-3" />
                    Collapse all
                </Button>
            </div>
            <JsonNode key={reset} value={data} reset={reset} />
        </div>
    );
}

// ── Formatted View ───────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono">{value}</span>
        </div>
    );
}

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
    const [copied, setCopied] = useState(false);
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={async () => {
                        if (
                            await writeClipboard(groupToMarkdown(group, index))
                        ) {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        }
                    }}
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

    return (
        <div className="space-y-5">
            {/* Packet header */}
            <div className="overflow-hidden rounded-md border">
                <div className="space-y-1 px-4 py-3">
                    <Row label="Packet ID" value={packet.id} />
                    <Row label="Created" value={formatTime(packet.createdAt)} />
                    <Row label="Groups" value={String(packet.groups.length)} />
                    <Row label="Edges" value={String(packet.edges.length)} />
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

    // Find the last flushed packet from dev entries
    const packet = useMemo(() => {
        for (let i = entries.length - 1; i >= 0; i--) {
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
    }, [entries]);

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3">
                {onSend ? (
                    <div className="flex items-center gap-1">
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
