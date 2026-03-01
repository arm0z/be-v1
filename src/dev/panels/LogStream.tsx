import { ALL_EVENTS, FilterToggles } from "./FilterToggles";
import {
    Check,
    ChevronRight,
    Copy,
    Pause,
    Play,
    Search,
    SlidersHorizontal,
    Trash2,
    X,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DevChannel, DevEntry } from "@/event/dev";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ── Constants ────────────────────────────────────────────

const ALL_CHANNELS: DevChannel[] = [
    "tap",
    "adapter",
    "normalizer",
    "relay",
    "aggregator",
    "packer",
    "navigation",
    "sync",
    "persistence",
];

const CHANNEL_CLASSES: Record<DevChannel, string> = {
    tap: "border-sky-500/50 bg-sky-500/10 text-sky-400",
    adapter: "border-amber-500/50 bg-amber-500/10 text-amber-400",
    normalizer: "border-violet-500/50 bg-violet-500/10 text-violet-400",
    relay: "border-rose-500/50 bg-rose-500/10 text-rose-400",
    aggregator: "border-emerald-500/50 bg-emerald-500/10 text-emerald-400",
    packer: "border-blue-500/50 bg-blue-500/10 text-blue-400",
    navigation: "border-cyan-500/50 bg-cyan-500/10 text-cyan-400",
    sync: "border-orange-500/50 bg-orange-500/10 text-orange-400",
    persistence: "border-teal-500/50 bg-teal-500/10 text-teal-400",
};

// ── Helpers ──────────────────────────────────────────────

type LogGroup = {
    entries: DevEntry[];
};

type DevFilter = {
    channels: Record<DevChannel, boolean>;
    events: Record<string, boolean>;
};

function formatTimestamp(ts: number) {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function groupConsecutive(entries: DevEntry[]): LogGroup[] {
    const groups: LogGroup[] = [];
    for (const entry of entries) {
        const last = groups[groups.length - 1];
        if (
            last &&
            last.entries[0].channel === entry.channel &&
            last.entries[0].event === entry.event
        ) {
            last.entries.push(entry);
        } else {
            groups.push({ entries: [entry] });
        }
    }
    return groups;
}

// ── Sub-components ───────────────────────────────────────

function CopyButton({ text, className }: { text: string; className?: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(
        async (e: React.MouseEvent) => {
            e.stopPropagation();
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        },
        [text],
    );

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleCopy}
                    className={cn("text-muted-foreground", className)}
                >
                    {copied ? <Check className="text-emerald-400" /> : <Copy />}
                </Button>
            </TooltipTrigger>
            <TooltipContent>Copy to clipboard</TooltipContent>
        </Tooltip>
    );
}

function EventFilterPopover({
    filter,
    setEventFilter,
}: {
    filter: DevFilter | null;
    setEventFilter: (events: Partial<Record<string, boolean>>) => void;
}) {
    const hiddenCount = useMemo(() => {
        if (!filter) return 0;
        return ALL_EVENTS.filter((e) => filter.events[e] === false).length;
    }, [filter]);

    return (
        <Popover>
            <Tooltip>
                <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                        <Button
                            variant="ghost"
                            size="xs"
                            className="relative text-muted-foreground"
                        >
                            <SlidersHorizontal />
                            Events
                            {hiddenCount > 0 && (
                                <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-none text-white">
                                    {hiddenCount}
                                </span>
                            )}
                        </Button>
                    </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Event filters</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-80">
                <div className="dev-scrollbar max-h-72 overflow-y-auto pr-1">
                    <FilterToggles
                        filter={filter}
                        setEventFilter={setEventFilter}
                    />
                </div>
            </PopoverContent>
        </Popover>
    );
}

function formatEntryTitle(entry: DevEntry) {
    const ts = formatTimestamp(entry.timestamp);
    const ev = entry.event ? ` ${entry.event}` : "";
    return `[${entry.channel}] ${ts}${ev} – ${entry.message}`;
}

function CopyDropdown({ filtered }: { filtered: DevEntry[] }) {
    const [feedback, setFeedback] = useState<string | null>(null);

    const copy = useCallback(async (text: string, label: string) => {
        await navigator.clipboard.writeText(text);
        setFeedback(label);
        setTimeout(() => setFeedback(null), 1500);
    }, []);

    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground"
                        >
                            {feedback ? (
                                <Check className="text-emerald-400" />
                            ) : (
                                <Copy />
                            )}
                        </Button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>More copy options</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
                <DropdownMenuItem
                    onClick={() =>
                        copy(JSON.stringify(filtered, null, 2), "detailed")
                    }
                >
                    <Copy className="h-3 w-3" />
                    Copy Detailed
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function LogToolbar({
    search,
    onSearchChange,
    paused,
    onTogglePause,
    count,
    filtered,
    filter,
    setEventFilter,
    onClear,
}: {
    search: string;
    onSearchChange: (v: string) => void;
    paused: boolean;
    onTogglePause: () => void;
    count: number;
    filtered: DevEntry[];
    filter: DevFilter | null;
    setEventFilter: (events: Partial<Record<string, boolean>>) => void;
    onClear: () => void;
}) {
    const [copyFeedback, setCopyFeedback] = useState(false);

    const handleCopyTitles = useCallback(() => {
        const titles = filtered.map(formatEntryTitle).join("\n");
        navigator.clipboard.writeText(titles);
        setCopyFeedback(true);
        setTimeout(() => setCopyFeedback(false), 1500);
    }, [filtered]);

    return (
        <div className="flex items-center gap-2 border-b bg-background px-3 py-1.5">
            {/* Search */}
            <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={search}
                    onChange={(e) => onSearchChange(e.target.value)}
                    placeholder="Filter logs…"
                    className="h-8 pl-8 pr-8"
                />
                {search && (
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => onSearchChange("")}
                        className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                    >
                        <X />
                    </Button>
                )}
            </div>

            {/* Event filters popover */}
            <EventFilterPopover
                filter={filter}
                setEventFilter={setEventFilter}
            />

            {/* Pause / Play */}
            <Button
                variant="ghost"
                size="xs"
                onClick={onTogglePause}
                className={cn(
                    paused
                        ? "bg-amber-500/10 text-amber-400"
                        : "text-muted-foreground",
                )}
            >
                {paused ? <Play /> : <Pause />}
                {paused ? "Resume" : "Pause"}
            </Button>

            {/* Entry count */}
            <span className="text-xs tabular-nums text-muted-foreground">
                {count}
            </span>

            {/* Copy titles */}
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="xs"
                        onClick={handleCopyTitles}
                        className="text-muted-foreground"
                    >
                        {copyFeedback ? (
                            <Check className="text-emerald-400" />
                        ) : (
                            <Copy />
                        )}
                        Copy
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Copy log titles</TooltipContent>
            </Tooltip>

            {/* Copy options dropdown */}
            <CopyDropdown filtered={filtered} />

            {/* Clear */}
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
        </div>
    );
}

function ChannelFilters({
    activeChannels,
    onToggle,
    onToggleAll,
}: {
    activeChannels: Set<DevChannel>;
    onToggle: (ch: DevChannel) => void;
    onToggleAll: () => void;
}) {
    const allSelected = activeChannels.size === ALL_CHANNELS.length;
    const noneSelected = activeChannels.size === 0;

    return (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-background px-3 py-1.5">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Checkbox
                        checked={allSelected ? true : noneSelected ? false : "indeterminate"}
                        onCheckedChange={onToggleAll}
                        className="cursor-pointer"
                    />
                </TooltipTrigger>
                <TooltipContent>{allSelected ? "Deselect all channels" : "Select all channels"}</TooltipContent>
            </Tooltip>
            {ALL_CHANNELS.map((ch) => (
                <button key={ch} type="button" onClick={() => onToggle(ch)}>
                    <Badge
                        variant="outline"
                        className={cn(
                            CHANNEL_CLASSES[ch],
                            "cursor-pointer transition-opacity",
                            !activeChannels.has(ch) && "opacity-30",
                        )}
                    >
                        {ch}
                    </Badge>
                </button>
            ))}
        </div>
    );
}

function SingleEntryRow({
    entry,
    expanded,
    onToggle,
}: {
    entry: DevEntry;
    expanded: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="group">
            <div className="flex w-full items-start gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted/50">
                <button
                    type="button"
                    onClick={onToggle}
                    className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
                >
                    {/* Expand chevron */}
                    <span className="mt-0.5 w-3 shrink-0">
                        <ChevronRight
                            className={cn(
                                "h-3 w-3 text-muted-foreground transition-transform",
                                expanded && "rotate-90",
                            )}
                        />
                    </span>

                    {/* Channel badge */}
                    <Badge
                        variant="outline"
                        className={cn(
                            CHANNEL_CLASSES[entry.channel],
                            "w-20 justify-center text-[10px] font-normal px-1.5 py-0",
                        )}
                    >
                        {entry.channel}
                    </Badge>

                    {/* Timestamp */}
                    <span className="mt-0.5 shrink-0 tabular-nums text-muted-foreground">
                        {formatTimestamp(entry.timestamp)}
                    </span>

                    {/* Event + message */}
                    <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        {entry.event && (
                            <span className="shrink-0 font-medium text-foreground">
                                {entry.event}
                            </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {entry.message}
                        </span>
                    </div>
                </button>

                {/* Copy */}
                <CopyButton
                    text={JSON.stringify(entry, null, 2)}
                    className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                />
            </div>

            {expanded && (
                <pre className="mx-3 mb-1 ml-11 dev-scrollbar overflow-x-auto rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
                    {JSON.stringify(entry, null, 2)}
                </pre>
            )}
        </div>
    );
}

function CollapsedGroupRow({
    group,
    expanded,
    onToggle,
}: {
    group: LogGroup;
    expanded: boolean;
    onToggle: () => void;
}) {
    const first = group.entries[0];

    return (
        <div className="group/collapsed">
            <div className="flex w-full items-start gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted/50">
                <button
                    type="button"
                    onClick={onToggle}
                    className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
                >
                    <span className="mt-0.5 w-3 shrink-0">
                        <ChevronRight
                            className={cn(
                                "h-3 w-3 text-muted-foreground transition-transform",
                                expanded && "rotate-90",
                            )}
                        />
                    </span>

                    <Badge
                        variant="outline"
                        className={cn(
                            CHANNEL_CLASSES[first.channel],
                            "w-20 justify-center text-[10px] font-normal px-1.5 py-0",
                        )}
                    >
                        {first.channel}
                    </Badge>

                    <span className="mt-0.5 shrink-0 tabular-nums text-muted-foreground">
                        {formatTimestamp(first.timestamp)}
                    </span>

                    <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        {first.event && (
                            <span className="shrink-0 font-medium text-foreground">
                                {first.event}
                            </span>
                        )}
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                            x{group.entries.length}
                        </span>
                    </div>
                </button>

                {/* Copy all entries in group */}
                <CopyButton
                    text={JSON.stringify(group.entries, null, 2)}
                    className="shrink-0 opacity-0 transition-opacity group-hover/collapsed:opacity-100"
                />
            </div>

            {expanded && (
                <div className="divide-y border-l-2 border-muted ml-[1.65rem]">
                    {group.entries.map((entry, j) => (
                        <div
                            key={`${entry.timestamp}-${j}`}
                            className="group/entry px-3 py-1 text-xs"
                        >
                            <div className="flex items-start gap-2">
                                <span className="w-3 shrink-0" />
                                <span className="w-20 shrink-0" />
                                <span className="mt-0.5 shrink-0 tabular-nums text-muted-foreground">
                                    {formatTimestamp(entry.timestamp)}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                    {entry.message}
                                </span>
                                <CopyButton
                                    text={JSON.stringify(entry, null, 2)}
                                    className="shrink-0 opacity-0 transition-opacity group-hover/entry:opacity-100"
                                />
                            </div>
                            <pre className="mt-1 ml-23 dev-scrollbar overflow-x-auto rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
                                {JSON.stringify(entry, null, 2)}
                            </pre>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Main component ───────────────────────────────────────

type Props = {
    entries: DevEntry[];
    filter: DevFilter | null;
    setEventFilter: (events: Partial<Record<string, boolean>>) => void;
};

export function LogStream({ entries, filter, setEventFilter }: Props) {
    const [search, setSearch] = useState("");
    const [activeChannels, setActiveChannels] = useState<Set<DevChannel>>(
        () => new Set(ALL_CHANNELS),
    );
    const [expandedIndices, setExpandedIndices] = useState<Set<number>>(
        () => new Set(),
    );
    const [paused, setPaused] = useState(false);
    const [clearedAt, setClearedAt] = useState(0);

    // Snapshot entries when pausing
    const pausedEntriesRef = useRef<DevEntry[]>([]);

    const baseEntries = paused ? pausedEntriesRef.current : entries;
    const displayEntries =
        clearedAt > 0
            ? baseEntries.filter((e) => e.timestamp > clearedAt)
            : baseEntries;

    const togglePause = useCallback(() => {
        setPaused((prev) => {
            if (!prev) {
                pausedEntriesRef.current = entries;
            }
            return !prev;
        });
    }, [entries]);

    const handleClear = useCallback(() => {
        setClearedAt(Date.now());
        setExpandedIndices(new Set());
    }, []);

    const toggleChannel = useCallback((ch: DevChannel) => {
        setActiveChannels((prev) => {
            const next = new Set(prev);
            if (next.has(ch)) next.delete(ch);
            else next.add(ch);
            return next;
        });
    }, []);

    const toggleAllChannels = useCallback(() => {
        setActiveChannels((prev) => {
            if (prev.size === ALL_CHANNELS.length) return new Set();
            return new Set(ALL_CHANNELS);
        });
    }, []);

    const toggleExpand = useCallback((index: number) => {
        setExpandedIndices((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    }, []);

    // Filter entries and group consecutive duplicates
    const filtered = useMemo(() => {
        const q = search.toLowerCase();
        return displayEntries.filter((entry) => {
            if (!activeChannels.has(entry.channel)) return false;
            if (!q) return true;
            return (
                entry.message.toLowerCase().includes(q) ||
                (entry.event?.toLowerCase().includes(q) ?? false) ||
                (entry.source?.toLowerCase().includes(q) ?? false)
            );
        });
    }, [displayEntries, activeChannels, search]);

    const groups = useMemo(() => groupConsecutive(filtered), [filtered]);

    // Auto-scroll: only when user is near bottom and not paused
    const bottomRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const stickToBottom = useRef(true);

    const scrollRef = useCallback((node: HTMLDivElement | null) => {
        viewportRef.current = node;
    }, []);

    useEffect(() => {
        const vp = viewportRef.current;
        if (!vp) return;
        function onScroll() {
            const el = viewportRef.current;
            if (!el) return;
            const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
            stickToBottom.current = gap < 40;
        }
        vp.addEventListener("scroll", onScroll, { passive: true });
        return () => vp.removeEventListener("scroll", onScroll);
    }, []);

    useEffect(() => {
        if (paused || !stickToBottom.current) return;
        bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }, [filtered.length, paused]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0">
                <LogToolbar
                    search={search}
                    onSearchChange={setSearch}
                    paused={paused}
                    onTogglePause={togglePause}
                    count={filtered.length}
                    filtered={filtered}
                    filter={filter}
                    setEventFilter={setEventFilter}
                    onClear={handleClear}
                />
                <ChannelFilters
                    activeChannels={activeChannels}
                    onToggle={toggleChannel}
                    onToggleAll={toggleAllChannels}
                />
            </div>

            <div
                ref={scrollRef}
                className="dev-scrollbar min-h-0 flex-1 overflow-y-auto"
            >
                {filtered.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        {displayEntries.length === 0
                            ? "Waiting for log entries…"
                            : "No entries match the current filters."}
                    </p>
                ) : (
                    <div className="divide-y pb-16">
                        {groups.map((group, i) =>
                            group.entries.length === 1 ? (
                                <SingleEntryRow
                                    key={`${group.entries[0].timestamp}-${i}`}
                                    entry={group.entries[0]}
                                    expanded={expandedIndices.has(i)}
                                    onToggle={() => toggleExpand(i)}
                                />
                            ) : (
                                <CollapsedGroupRow
                                    key={`${group.entries[0].timestamp}-${i}`}
                                    group={group}
                                    expanded={expandedIndices.has(i)}
                                    onToggle={() => toggleExpand(i)}
                                />
                            ),
                        )}
                    </div>
                )}
                <div ref={bottomRef} />
            </div>
        </div>
    );
}
