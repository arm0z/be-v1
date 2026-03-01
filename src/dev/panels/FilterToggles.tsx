import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { DevFilter } from "@/event/dev";
import { Input } from "@/components/ui/input";

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
        events: ["attention.active", "attention.visible"],
    },
    {
        label: "KEYSTROKES",
        events: [
            "input.keystroke",
            "input.keystroke_batch",
            "input.keystroke.batch",
            "input.keystroke.flush",
            "input.composition",
        ],
    },
    {
        label: "MOUSE",
        events: ["input.click", "input.double_click", "input.context_menu"],
    },
    {
        label: "SCROLL",
        events: ["input.scroll", "input.scroll.flush"],
    },
    {
        label: "CLIPBOARD",
        events: [
            "input.selection",
            "input.selection.flush",
            "input.selection.drop",
            "input.copy",
            "input.paste",
        ],
    },
    {
        label: "FORMS",
        events: [
            "input.form_focus",
            "input.form_focus.dedup",
            "input.form_change",
            "input.form_submit",
        ],
    },
    {
        label: "MEDIA",
        events: ["media.audio", "media.download"],
    },
    {
        label: "ADAPTERS",
        events: ["html.content", "file.content", "filtered"],
    },
    {
        label: "AGGREGATOR",
        events: [
            "bundle.opened",
            "bundle.sealed",
            "transition",
            "state.snapshot",
        ],
    },
    {
        label: "PACKER",
        events: [
            "pack.preprocessed",
            "pack.graph",
            "pack.louvain",
            "pack.flushed",
        ],
    },
    {
        label: "VISIBILITY",
        events: [
            "tab.visible",
            "off_browser.start",
            "off_browser.cancel",
            "off_browser.commit",
        ],
    },
];

export const ALL_EVENTS = EVENT_GROUPS.flatMap((g) => g.events);

type Props = {
    filter: DevFilter | null;
    setEventFilter: (events: Partial<Record<string, boolean>>) => void;
};

export function FilterToggles({ filter, setEventFilter }: Props) {
    const [search, setSearch] = useState("");

    const q = search.toLowerCase();

    const filteredGroups = useMemo(
        () =>
            q
                ? EVENT_GROUPS.map((group) => {
                      const labelMatch = group.label.toLowerCase().includes(q);
                      return {
                          ...group,
                          events: labelMatch
                              ? group.events
                              : group.events.filter((e) =>
                                    e.toLowerCase().includes(q),
                                ),
                      };
                  }).filter((g) => g.events.length > 0)
                : EVENT_GROUPS,
        [q],
    );

    const matchedEvents = useMemo(
        () => filteredGroups.flatMap((g) => g.events),
        [filteredGroups],
    );

    if (!filter) {
        return (
            <p className="text-center text-sm text-muted-foreground">
                Connecting to dev hub...
            </p>
        );
    }

    const allMatchedOn = matchedEvents.every((e) => filter.events[e] !== false);

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
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search events…"
                        className="h-8 pl-8 pr-8"
                    />
                    {search && (
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setSearch("")}
                            className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                        >
                            <X />
                        </Button>
                    )}
                </div>
                <Button
                    variant="outline"
                    size="xs"
                    onClick={allMatchedOn ? deselectAll : selectAll}
                    className="text-muted-foreground"
                >
                    {q
                        ? allMatchedOn
                            ? "Deselect matches"
                            : "Select matches"
                        : allMatchedOn
                          ? "Deselect all"
                          : "Select all"}
                </Button>
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
                                    <Checkbox
                                        checked={enabled}
                                        onCheckedChange={(checked) =>
                                            setEventFilter({
                                                [event]: !!checked,
                                            })
                                        }
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
