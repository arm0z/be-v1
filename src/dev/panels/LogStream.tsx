import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DevChannel, DevEntry } from "@/event/dev";
import { cn } from "@/lib/utils";
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
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ALL_EVENTS, FilterToggles } from "./FilterToggles";

// ── Constants ────────────────────────────────────────────

const ALL_CHANNELS: DevChannel[] = [
	"tap",
	"adapter",
	"normalizer",
	"relay",
	"aggregator",
	"graph",
	"sync",
	"persistence",
];

const CHANNEL_CLASSES: Record<DevChannel, string> = {
	tap: "border-sky-500/50 bg-sky-500/10 text-sky-400",
	adapter: "border-amber-500/50 bg-amber-500/10 text-amber-400",
	normalizer: "border-violet-500/50 bg-violet-500/10 text-violet-400",
	relay: "border-rose-500/50 bg-rose-500/10 text-rose-400",
	aggregator: "border-emerald-500/50 bg-emerald-500/10 text-emerald-400",
	graph: "border-blue-500/50 bg-blue-500/10 text-blue-400",
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
		if (last && last.entries[0].channel === entry.channel && last.entries[0].event === entry.event) {
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
		<Button
			variant="ghost"
			size="icon-xs"
			onClick={handleCopy}
			className={cn("text-muted-foreground", className)}
			title="Copy to clipboard"
		>
			{copied ? (
				<Check className="text-emerald-400" />
			) : (
				<Copy />
			)}
		</Button>
	);
}

function EventFilterPopover({
	filter,
	setEventFilter,
}: {
	filter: DevFilter | null;
	setEventFilter: (events: Partial<Record<string, boolean>>) => void;
}) {
	const [open, setOpen] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout>>();
	const containerRef = useRef<HTMLDivElement>(null);

	const hiddenCount = useMemo(() => {
		if (!filter) return 0;
		return ALL_EVENTS.filter((e) => filter.events[e] === false).length;
	}, [filter]);

	const handleEnter = useCallback(() => {
		clearTimeout(closeTimer.current);
		setOpen(true);
	}, []);

	const handleLeave = useCallback(() => {
		closeTimer.current = setTimeout(() => setOpen(false), 200);
	}, []);

	useEffect(() => () => clearTimeout(closeTimer.current), []);

	return (
		<div
			ref={containerRef}
			className="relative"
			onMouseEnter={handleEnter}
			onMouseLeave={handleLeave}
		>
			<Button
				variant="ghost"
				size="xs"
				onClick={() => setOpen((p) => !p)}
				className={cn(
					"relative",
					open
						? "bg-foreground/10 text-foreground"
						: "text-muted-foreground",
				)}
				title="Event filters"
			>
				<SlidersHorizontal />
				Events
				{hiddenCount > 0 && (
					<span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-none text-white">
						{hiddenCount}
					</span>
				)}
			</Button>

			{open && (
				<div className="absolute left-1/2 top-full z-50 mt-1 w-80 -translate-x-1/2 rounded-lg border bg-background p-4 shadow-lg">
					<div className="dev-scrollbar max-h-72 overflow-y-auto pr-1">
						<FilterToggles
							filter={filter}
							setEventFilter={setEventFilter}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

function LogToolbar({
	search,
	onSearchChange,
	paused,
	onTogglePause,
	count,
	onClear,
	onCopyAll,
	filter,
	setEventFilter,
}: {
	search: string;
	onSearchChange: (v: string) => void;
	paused: boolean;
	onTogglePause: () => void;
	count: number;
	onClear: () => void;
	onCopyAll: () => void;
	filter: DevFilter | null;
	setEventFilter: (events: Partial<Record<string, boolean>>) => void;
}) {
	const [copyFeedback, setCopyFeedback] = useState(false);

	const handleCopyAll = useCallback(() => {
		onCopyAll();
		setCopyFeedback(true);
		setTimeout(() => setCopyFeedback(false), 1500);
	}, [onCopyAll]);

	return (
		<div className="flex items-center gap-2 border-b bg-background px-3 py-1.5">
			{/* Search */}
			<div className="relative flex-1">
				<Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					type="text"
					value={search}
					onChange={(e) => onSearchChange(e.target.value)}
					placeholder="Filter logs…"
					className="h-8 w-full rounded-md border bg-transparent pl-8 pr-8 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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

			{/* Copy all */}
			<Button
				variant="ghost"
				size="xs"
				onClick={handleCopyAll}
				className="text-muted-foreground"
				title="Copy all visible logs"
			>
				{copyFeedback ? (
					<Check className="text-emerald-400" />
				) : (
					<Copy />
				)}
				Copy
			</Button>

			{/* Clear */}
			<Button
				variant="ghost"
				size="xs"
				onClick={onClear}
				className="text-muted-foreground"
			>
				<Trash2 />
				Clear
			</Button>
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
	const checkRef = useRef<HTMLInputElement>(null);
	const allSelected = activeChannels.size === ALL_CHANNELS.length;
	const noneSelected = activeChannels.size === 0;

	useEffect(() => {
		if (checkRef.current) {
			checkRef.current.indeterminate = !allSelected && !noneSelected;
		}
	}, [allSelected, noneSelected]);

	return (
		<div className="flex flex-wrap items-center gap-1.5 border-b bg-background px-3 py-1.5">
			<input
				ref={checkRef}
				type="checkbox"
				checked={allSelected}
				onChange={onToggleAll}
				className="h-3.5 w-3.5 cursor-pointer rounded border-muted-foreground accent-foreground"
				title={allSelected ? "Deselect all channels" : "Select all channels"}
			/>
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
						className={cn(CHANNEL_CLASSES[entry.channel], "w-20 justify-center text-[10px] font-normal px-1.5 py-0")}
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
				<pre className="mx-3 mb-1 ml-[2.75rem] dev-scrollbar overflow-x-auto rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
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
						className={cn(CHANNEL_CLASSES[first.channel], "w-20 justify-center text-[10px] font-normal px-1.5 py-0")}
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
							<pre className="mt-1 ml-[5.75rem] dev-scrollbar overflow-x-auto rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
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
	onClear: () => void;
	filter: DevFilter | null;
	setEventFilter: (events: Partial<Record<string, boolean>>) => void;
};

export function LogStream({ entries, onClear, filter, setEventFilter }: Props) {
	const [search, setSearch] = useState("");
	const [activeChannels, setActiveChannels] = useState<Set<DevChannel>>(
		() => new Set(ALL_CHANNELS),
	);
	const [expandedIndices, setExpandedIndices] = useState<Set<number>>(
		() => new Set(),
	);
	const [paused, setPaused] = useState(false);

	// Snapshot entries when pausing
	const pausedEntriesRef = useRef<DevEntry[]>([]);

	const displayEntries = paused ? pausedEntriesRef.current : entries;

	const togglePause = useCallback(() => {
		setPaused((prev) => {
			if (!prev) {
				pausedEntriesRef.current = entries;
			}
			return !prev;
		});
	}, [entries]);

	const handleClear = useCallback(() => {
		onClear();
		setExpandedIndices(new Set());
	}, [onClear]);

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

	const handleCopyAll = useCallback(() => {
		navigator.clipboard.writeText(JSON.stringify(filtered, null, 2));
	}, [filtered]);

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
					onClear={handleClear}
					onCopyAll={handleCopyAll}
					filter={filter}
					setEventFilter={setEventFilter}
				/>
				<ChannelFilters
					activeChannels={activeChannels}
					onToggle={toggleChannel}
					onToggleAll={toggleAllChannels}
				/>
			</div>

			<div ref={scrollRef} className="dev-scrollbar min-h-0 flex-1 overflow-y-auto">
				{filtered.length === 0 ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						{entries.length === 0
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
