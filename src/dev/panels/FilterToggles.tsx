import type { DevChannel } from "@/event/dev";
import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * All Capture event types from types.ts, grouped by layer.
 * Matches the Capture discriminated union exactly.
 */
const EVENT_GROUPS: { label: string; events: string[] }[] = [
	{
		label: "SESSION",
		events: [
			"window.created",
			"window.closed",
			"window.resized",
			"tab.created",
			"tab.closed",
			"tab.moved",
			"tab.transferred",
		],
	},
	{
		label: "NAVIGATION",
		events: ["nav.completed", "nav.spa", "nav.title_changed"],
	},
	{
		label: "ATTENTION",
		events: [
			"attention.active",
			"attention.visible",
			"attention.mouse_presence",
			"attention.idle",
		],
	},
	{
		label: "KEYSTROKES",
		events: ["input.keystroke", "input.composition"],
	},
	{
		label: "MOUSE",
		events: ["input.click", "input.double_click", "input.context_menu"],
	},
	{
		label: "SCROLL",
		events: ["input.scroll"],
	},
	{
		label: "CLIPBOARD",
		events: ["input.selection", "input.copy", "input.paste"],
	},
	{
		label: "FORMS",
		events: ["input.form_focus", "input.form_change", "input.form_submit"],
	},
	{
		label: "MEDIA",
		events: ["media.audio", "media.download"],
	},
	{
		label: "ADAPTERS",
		events: ["html.content", "file.content"],
	},
];

const ALL_EVENTS = EVENT_GROUPS.flatMap((g) => g.events);

type DevFilter = {
	channels: Record<DevChannel, boolean>;
	events: Record<string, boolean>;
};

type Props = {
	filter: DevFilter | null;
	setEventFilter: (events: Partial<Record<string, boolean>>) => void;
};

export function FilterToggles({ filter, setEventFilter }: Props) {
	const [search, setSearch] = useState("");

	const q = search.toLowerCase();

	const matchedEvents = useMemo(
		() =>
			q
				? ALL_EVENTS.filter((e) => e.toLowerCase().includes(q))
				: ALL_EVENTS,
		[q],
	);

	const filteredGroups = useMemo(
		() =>
			EVENT_GROUPS.map((group) => ({
				...group,
				events: group.events.filter((e) =>
					e.toLowerCase().includes(q),
				),
			})).filter((g) => g.events.length > 0),
		[q],
	);

	if (!filter) {
		return (
			<p className="text-center text-sm text-muted-foreground">
				Connecting to dev hub...
			</p>
		);
	}

	const allMatchedOn = matchedEvents.every(
		(e) => filter.events[e] !== false,
	);

	function selectAll() {
		const patch: Record<string, boolean> = {};
		for (const e of matchedEvents) patch[e] = true;
		setEventFilter(patch);
	}

	function deselectAll() {
		const patch: Record<string, boolean> = {};
		for (const e of matchedEvents) patch[e] = false;
		setEventFilter(patch);
	}

	return (
		<div className="mx-auto max-w-md space-y-4">
			{/* Search + bulk actions */}
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search events…"
						className="h-8 w-full rounded-md border bg-transparent pl-8 pr-8 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
					/>
					{search && (
						<button
							type="button"
							onClick={() => setSearch("")}
							className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					)}
				</div>
				<button
					type="button"
					onClick={allMatchedOn ? deselectAll : selectAll}
					className="shrink-0 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					{q
						? allMatchedOn
							? "Deselect matches"
							: "Select matches"
						: allMatchedOn
							? "Deselect all"
							: "Select all"}
				</button>
			</div>

			{/* Event groups */}
			{filteredGroups.map((group) => (
				<div key={group.label}>
					<p className="mb-1 text-[10px] tracking-widest text-muted-foreground">
						{group.label}
					</p>
					<div className="space-y-px">
						{group.events.map((event) => {
							const enabled = filter.events[event] !== false;
							return (
								<label
									key={event}
									className="flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-xs transition-colors hover:bg-muted/50"
								>
									<span className="font-mono text-muted-foreground">
										{event}
									</span>
									<input
										type="checkbox"
										checked={enabled}
										onChange={(e) =>
											setEventFilter({
												[event]: e.target.checked,
											})
										}
										className="h-3.5 w-3.5 rounded border-muted-foreground accent-foreground"
									/>
								</label>
							);
						})}
					</div>
				</div>
			))}
		</div>
	);
}
