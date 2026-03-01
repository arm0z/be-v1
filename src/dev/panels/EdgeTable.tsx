import type { LouvainResult, Transition } from "@/aggregation/types";

import { formatDwell, formatTime } from "../lib/format";
import { getCommunityColor, nodeColor } from "./GraphView";

type Edge = { from: string; to: string; weight: number };

function SourceCell({
    id,
    urls,
}: {
    id: string;
    urls: Record<string, string>;
}) {
    const url = urls[id] ?? "";
    return (
        <span className="flex flex-col leading-tight">
            <span className="truncate" style={{ maxWidth: 200 }} title={id}>
                {id}
            </span>
            {url && (
                <span
                    className="truncate text-[10px] text-muted-foreground"
                    style={{ maxWidth: 200 }}
                    title={url}
                >
                    {url}
                </span>
            )}
        </span>
    );
}

function TransitionTable({
    transitions,
    colorFn,
    sourceUrls,
}: {
    transitions: Transition[];
    colorFn: (id: string) => string;
    sourceUrls: Record<string, string>;
}) {
    const nodeSet = new Set<string>();
    for (const t of transitions) {
        nodeSet.add(t.from);
        nodeSet.add(t.to);
    }

    return (
        <div className="dev-scrollbar flex h-full flex-col overflow-y-auto">
            {/* Nodes strip */}
            <div className="flex flex-wrap gap-1.5 border-b border-border/50 px-3 py-2">
                {[...nodeSet].map((id) => (
                    <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-full border border-border/50 px-2 py-0.5 text-[11px]"
                    >
                        <span
                            className="inline-block size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: colorFn(id) }}
                        />
                        <SourceCell id={id} urls={sourceUrls} />
                    </span>
                ))}
            </div>

            <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-background">
                    <tr className="border-b border-border/50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-3 py-1.5 font-medium">#</th>
                        <th className="px-3 py-1.5 font-medium">From</th>
                        <th className="px-1 py-1.5 font-medium" />
                        <th className="px-3 py-1.5 font-medium">To</th>
                        <th className="px-3 py-1.5 text-right font-medium">
                            Dwell
                        </th>
                        <th className="px-3 py-1.5 text-right font-medium">
                            Time
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {transitions.map((t, i) => (
                        <tr
                            key={i}
                            className="border-b border-border/20 hover:bg-muted/20"
                        >
                            <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
                                {i + 1}
                            </td>
                            <td className="px-3 py-1.5">
                                <span className="inline-flex items-center gap-1.5">
                                    <span
                                        className="mt-0.5 inline-block size-1.5 shrink-0 rounded-full"
                                        style={{
                                            backgroundColor: colorFn(t.from),
                                        }}
                                    />
                                    <SourceCell id={t.from} urls={sourceUrls} />
                                </span>
                            </td>
                            <td className="px-1 py-1.5 text-muted-foreground">
                                &rarr;
                            </td>
                            <td className="px-3 py-1.5">
                                <span className="inline-flex items-center gap-1.5">
                                    <span
                                        className="mt-0.5 inline-block size-1.5 shrink-0 rounded-full"
                                        style={{
                                            backgroundColor: colorFn(t.to),
                                        }}
                                    />
                                    <SourceCell id={t.to} urls={sourceUrls} />
                                </span>
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                                {formatDwell(t.dwellMs)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                                {formatTime(t.ts)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function EdgeTable({
    transitions,
    grouped,
    louvain,
    sourceUrls,
}: {
    transitions: Transition[];
    grouped: boolean;
    louvain: LouvainResult | null;
    sourceUrls: Record<string, string>;
}) {
    if (transitions.length === 0) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No edge data yet — edges appear as transitions flow
            </div>
        );
    }

    if (grouped && louvain) {
        const uniqueCommunities = [...new Set(louvain.communities.values())];
        const communityColor = (id: string): string => {
            const community = louvain.communities.get(id);
            return community
                ? getCommunityColor(community, uniqueCommunities)
                : "hsl(0,0%,45%)";
        };
        return (
            <TransitionTable
                transitions={transitions}
                colorFn={communityColor}
                sourceUrls={sourceUrls}
            />
        );
    }

    return (
        <TransitionTable
            transitions={transitions}
            colorFn={nodeColor}
            sourceUrls={sourceUrls}
        />
    );
}
