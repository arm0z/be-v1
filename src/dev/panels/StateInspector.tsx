import {
    Braces,
    ChevronDown,
    ChevronUp,
    ChevronsDownUp,
    ChevronsUpDown,
    ClipboardCheck,
    ClipboardCopy,
    LayoutList,
    Package,
    RotateCcw,
    Trash2,
    Upload,
} from "lucide-react";
import type {
    DevCaptureSummary,
    DevEntry,
    DevStateSnapshot,
} from "@/event/dev";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { writeClipboard } from "@/lib/utils";

// ── Helpers ──────────────────────────────────────────────────────────

function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString();
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

function SourceLabel({ source }: { source: string }) {
    return <span className="font-mono">{source}</span>;
}

// ── JSON Tree ────────────────────────────────────────────────────────

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

    // reset encodes target state: even = collapse all, odd = expand all
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
                className="flex items-baseline gap-1.5 py-px rounded px-1 -ml-1 hover:bg-muted/30"
            >
                <span className="text-muted-foreground text-[10px] w-2.5 shrink-0">
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

function JsonTreeView({ snapshot }: { snapshot: unknown }) {
    // Even = collapsed (default depth<2), odd = expand all
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
            <JsonNode key={reset} value={snapshot} reset={reset} />
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

type SealedBundle = DevStateSnapshot["sealedBundles"][number];

function bundleToMarkdown(b: SealedBundle, i: number): string {
    const lines = [`## Bundle #${i} — ${b.source}`];
    lines.push(
        `**Span:** ${formatTime(b.startedAt)} – ${b.endedAt ? formatTime(b.endedAt) : "..."}`,
    );
    if (b.endedAt)
        lines.push(`**Duration:** ${formatDuration(b.endedAt - b.startedAt)}`);
    lines.push(`**Captures:** ${b.captureCount}`);
    if (b.text) lines.push("", "### Activity", "", b.text);
    return lines.join("\n");
}

function CopyBundleButton({
    bundle,
    index,
}: {
    bundle: SealedBundle;
    index: number;
}) {
    const [copied, setCopied] = useState(false);
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={async () => {
                        if (
                            await writeClipboard(
                                bundleToMarkdown(bundle, index),
                            )
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
                        <ClipboardCopy className="h-3.5 w-3.5" />
                    )}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
        </Tooltip>
    );
}

function CapturesList({ captures }: { captures: DevCaptureSummary[] }) {
    const [open, setOpen] = useState(false);
    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex items-center gap-1.5 text-sm"
            >
                <span className="text-[10px] text-muted-foreground">
                    {open ? "▼" : "▶"}
                </span>
                <span className="text-muted-foreground">Captures</span>
                <span className="font-mono">{captures.length}</span>
            </button>
            {open && (
                <div className="mt-1 ml-3 border-l border-border/50 pl-3">
                    {captures.map((c, j) => (
                        <div
                            key={`${c.timestamp}-${j}`}
                            className="flex items-baseline gap-3 py-px text-xs"
                        >
                            <span className="text-muted-foreground/60 font-mono">
                                {formatTime(c.timestamp)}
                            </span>
                            <span className="font-mono">{c.type}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function FormattedState({ snapshot }: { snapshot: DevStateSnapshot }) {
    // Track which bundles are collapsed by key
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const allExpanded = useMemo(() => {
        const withText = snapshot.sealedBundles.filter((b) => b.text);
        return (
            withText.length > 0 &&
            withText.every((b) => !collapsed.has(`${b.source}-${b.startedAt}`))
        );
    }, [snapshot.sealedBundles, collapsed]);

    const collapseAll = useCallback(() => {
        setCollapsed(
            new Set(
                snapshot.sealedBundles
                    .filter((b) => b.text)
                    .map((b) => `${b.source}-${b.startedAt}`),
            ),
        );
    }, [snapshot.sealedBundles]);

    const expandAll = useCallback(() => {
        setCollapsed(new Set());
    }, []);

    const toggleBundle = useCallback((key: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    return (
        <div className="space-y-5">
            {/* Active Source */}
            <div className="flex items-center justify-between rounded-md border p-3 text-sm">
                <span className="text-muted-foreground">Active Source</span>
                {snapshot.activeSource ? (
                    <SourceLabel source={snapshot.activeSource} />
                ) : (
                    <span className="font-mono">—</span>
                )}
            </div>

            {/* Open Bundle */}
            <section>
                <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Open Bundle
                </h3>
                {snapshot.openBundle ? (
                    <div className="overflow-hidden rounded-md border">
                        <div className="flex items-center gap-3 bg-muted/30 px-4 py-2">
                            <span className="text-green-400">●</span>
                            <SourceLabel source={snapshot.openBundle.source} />
                            <span className="ml-auto text-xs text-muted-foreground">
                                {formatDuration(
                                    Date.now() - snapshot.openBundle.startedAt,
                                )}
                            </span>
                        </div>
                        <div className="space-y-1 px-4 py-2">
                            <Row
                                label="Started"
                                value={formatTime(
                                    snapshot.openBundle.startedAt,
                                )}
                            />
                            <CapturesList
                                captures={snapshot.openBundle.captures}
                            />
                        </div>
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground/60">None</p>
                )}
            </section>

            {/* Sealed Bundles */}
            <section>
                <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        Sealed Bundles{" "}
                        <span className="ml-1 text-blue-400">
                            {snapshot.sealedBundles.length}
                        </span>
                    </h3>
                    {snapshot.sealedBundles.some((b) => b.text) && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="xs"
                                    onClick={
                                        allExpanded ? collapseAll : expandAll
                                    }
                                >
                                    {allExpanded ? (
                                        <ChevronsDownUp className="h-3 w-3" />
                                    ) : (
                                        <ChevronsUpDown className="h-3 w-3" />
                                    )}
                                    {allExpanded
                                        ? "Collapse all"
                                        : "Expand all"}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                {allExpanded
                                    ? "Collapse all bundle text"
                                    : "Expand all bundle text"}
                            </TooltipContent>
                        </Tooltip>
                    )}
                </div>
                {snapshot.sealedBundles.length === 0 ? (
                    <p className="text-sm text-muted-foreground/60">None</p>
                ) : (
                    <div className="space-y-2">
                        {snapshot.sealedBundles.map((b, i) => {
                            const key = `${b.source}-${b.startedAt}`;
                            const isCollapsed = collapsed.has(key);
                            return (
                                <div
                                    key={key}
                                    className="overflow-hidden rounded-md border"
                                >
                                    <div className="flex items-center gap-3 bg-muted/20 px-4 py-2 text-sm">
                                        <span className="text-muted-foreground">
                                            #{i}
                                        </span>
                                        <SourceLabel source={b.source} />
                                        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                                            {b.captureCount} captures
                                            <CopyBundleButton
                                                bundle={b}
                                                index={i}
                                            />
                                            {b.text && (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                toggleBundle(
                                                                    key,
                                                                )
                                                            }
                                                            className="flex items-center rounded p-1 text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                                                        >
                                                            {isCollapsed ? (
                                                                <ChevronDown className="h-3.5 w-3.5" />
                                                            ) : (
                                                                <ChevronUp className="h-3.5 w-3.5" />
                                                            )}
                                                        </button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>
                                                        {isCollapsed
                                                            ? "Expand text"
                                                            : "Collapse text"}
                                                    </TooltipContent>
                                                </Tooltip>
                                            )}
                                        </span>
                                    </div>
                                    <div className="space-y-1 border-t border-border/50 px-4 py-2">
                                        <Row
                                            label="Span"
                                            value={`${formatTime(b.startedAt)} – ${b.endedAt ? formatTime(b.endedAt) : "..."}`}
                                        />
                                        {b.endedAt && (
                                            <Row
                                                label="Duration"
                                                value={formatDuration(
                                                    b.endedAt - b.startedAt,
                                                )}
                                            />
                                        )}
                                        <CapturesList captures={b.captures} />
                                        {b.text && !isCollapsed && (
                                            <pre className="mt-2 whitespace-pre-wrap wrap-break-word rounded bg-muted/20 p-2 text-xs text-muted-foreground/80">
                                                {b.text}
                                            </pre>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Transitions */}
            <section>
                <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Transitions{" "}
                    <span className="ml-1 text-blue-400">
                        {snapshot.transitions.length}
                    </span>
                </h3>
                {snapshot.transitions.length === 0 ? (
                    <p className="text-sm text-muted-foreground/60">None</p>
                ) : (
                    <div className="divide-y divide-border/50 overflow-hidden rounded-md border text-sm">
                        {snapshot.transitions.map((t, i) => (
                            <div
                                key={`${t.from}\0${t.to}\0${t.ts}\0${i}`}
                                className="flex items-center gap-2 px-4 py-1.5"
                            >
                                <SourceLabel source={t.from} />
                                <span className="text-muted-foreground">→</span>
                                <SourceLabel source={t.to} />
                                <span className="ml-auto font-mono text-muted-foreground">
                                    dwell: {t.dwellMs}ms, at: {formatTime(t.ts)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

// ── Main Component ───────────────────────────────────────────────────

export function StateInspector({
    entries,
    onSend,
    onClear,
}: {
    entries: DevEntry[];
    onSend?: (msg: { type: string }) => void;
    onClear?: () => void;
}) {
    const [format, setFormat] = useState("formatted");

    const snapshot = useMemo(() => {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].event === "state.snapshot") {
                return entries[i].data;
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
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => onSend({ type: "sync.drain_retry" })}
                            className="text-muted-foreground"
                        >
                            <RotateCcw className="size-3" />
                            Retry
                        </Button>
                    </div>
                ) : (
                    <span />
                )}
                <div className="flex items-center gap-2">
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
                    {onClear && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={onClear}
                                    className="text-muted-foreground"
                                >
                                    <Trash2 />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Clear all</TooltipContent>
                        </Tooltip>
                    )}
                </div>
            </div>
            <div className="dev-scrollbar min-h-0 flex-1 overflow-auto p-4">
                {!snapshot && (
                    <p className="text-sm text-muted-foreground">
                        No state snapshot received yet.
                    </p>
                )}
                {!!snapshot && format === "json" && (
                    <JsonTreeView snapshot={snapshot} />
                )}
                {!!snapshot && format === "formatted" && (
                    <FormattedState snapshot={snapshot as DevStateSnapshot} />
                )}
            </div>
        </div>
    );
}
