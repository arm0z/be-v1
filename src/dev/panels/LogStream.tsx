import { Badge } from "@/components/ui/badge";
import type { DevChannel, DevEntry } from "@/event/dev";
import { cn } from "@/lib/utils";
import {
	ChevronRight,
	Pause,
	Play,
	Search,
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

const CHANNEL_COLORS: Record<DevChannel, string> = {
	tap: "sky",
	adapter: "amber",
	normalizer: "violet",
	relay: "rose",
	aggregator: "emerald",
	graph: "blue",
	sync: "orange",
	persistence: "teal",
};

// Tailwind needs full class strings (no interpolation) to detect them.
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

function LogToolbar({
	search,
	onSearchChange,
	paused,
	onTogglePause,
	count,
	onClear,
}: {
	search: string;
	onSearchChange: (v: string) => void;
	paused: boolean;
	onTogglePause: () => void;
	count: number;
	onClear: () => void;
}) {
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
					<button
						type="button"
						onClick={() => onSearchChange("")}
						className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				)}
			</div>

			{/* Pause / Play */}
			<button
				type="button"
				onClick={onTogglePause}
				className={cn(
					"inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
					paused
						? "bg-amber-500/10 text-amber-400"
						: "text-muted-foreground hover:text-foreground",
				)}
			>
				{paused ? (
					<Play className="h-3.5 w-3.5" />
				) : (
					<Pause className="h-3.5 w-3.5" />
				)}
				{paused ? "Resume" : "Pause"}
			</button>

			{/* Entry count */}
			<span className="text-xs tabular-nums text-muted-foreground">
				{count}
			</span>

			{/* Clear */}
			<button
				type="button"
				onClick={onClear}
				className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<Trash2 className="h-3.5 w-3.5" />
				Clear
			</button>
		</div>
	);
}

function ChannelFilters({
	activeChannels,
	onToggle,
}: {
	activeChannels: Set<DevChannel>;
	onToggle: (ch: DevChannel) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-1.5 border-b bg-background px-3 py-1.5">
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
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
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

				{/* Channel badge — fixed width, centered */}
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

			{expanded && (
				<pre className="mx-3 mb-1 ml-[2.75rem] overflow-x-auto rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
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
		<div>
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
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

			{expanded && (
				<div className="divide-y border-l-2 border-muted ml-[1.65rem]">
					{group.entries.map((entry, j) => (
						<div
							key={`${entry.timestamp}-${j}`}
							className="px-3 py-1 text-xs"
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
							</div>
							<pre className="mt-1 ml-[5.75rem] overflow-x-auto rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
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
};

export function LogStream({ entries, onClear }: Props) {
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
				// Entering paused state — capture snapshot
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
					onClear={handleClear}
				/>
				<ChannelFilters
					activeChannels={activeChannels}
					onToggle={toggleChannel}
				/>
			</div>

			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
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
