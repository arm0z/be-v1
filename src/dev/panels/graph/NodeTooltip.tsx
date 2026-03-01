import { useMemo, type MutableRefObject, type RefObject } from "react";
import type { Edge, Node } from "./types";
import { fmtTime } from "./types";

type TooltipStats = {
    inbound: { from: string; weight: number }[];
    outbound: { to: string; weight: number }[];
    totalWeight: number;
    degree: number;
};

export function useTooltipStats(
    hoverNodeId: string | null,
    edgesRef: MutableRefObject<Map<string, Edge>>,
): TooltipStats | null {
    return useMemo(() => {
        if (!hoverNodeId) return null;
        const inbound: { from: string; weight: number }[] = [];
        const outbound: { to: string; weight: number }[] = [];
        for (const edge of edgesRef.current.values()) {
            if (edge.to === hoverNodeId)
                inbound.push({ from: edge.from, weight: edge.weight });
            if (edge.from === hoverNodeId)
                outbound.push({ to: edge.to, weight: edge.weight });
        }
        const totalWeight = [...inbound, ...outbound].reduce((s, e) => s + e.weight, 0);
        return { inbound, outbound, totalWeight, degree: inbound.length + outbound.length };
    }, [hoverNodeId, edgesRef]);
}

export function NodeTooltip({
    hoverNodeId,
    nodesRef,
    tooltipRef,
    stats,
}: {
    hoverNodeId: string | null;
    nodesRef: MutableRefObject<Map<string, Node>>;
    tooltipRef: RefObject<HTMLDivElement | null>;
    stats: TooltipStats | null;
}) {
    if (!hoverNodeId || !stats) return null;
    const node = nodesRef.current.get(hoverNodeId);
    if (!node) return null;

    return (
        <div
            ref={tooltipRef}
            className="pointer-events-none absolute bottom-3 right-3 z-10 w-52 rounded-lg border border-border/50 bg-popover/95 p-3 text-xs text-popover-foreground opacity-0 shadow-xl backdrop-blur-sm"
        >
            <div className="truncate text-sm font-semibold">{node.id}</div>

            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 border-t border-border/30 pt-2">
                <span className="text-muted-foreground">Degree</span>
                <span className="text-right tabular-nums">{stats.degree}</span>
                <span className="text-muted-foreground">Inbound</span>
                <span className="text-right tabular-nums">{stats.inbound.length}</span>
                <span className="text-muted-foreground">Outbound</span>
                <span className="text-right tabular-nums">{stats.outbound.length}</span>
                <span className="text-muted-foreground">Total wt.</span>
                <span className="text-right tabular-nums">{stats.totalWeight}</span>
            </div>

            {stats.outbound.length > 0 && (
                <div className="mt-2 space-y-px border-t border-border/30 pt-2">
                    <span className="text-muted-foreground text-[10px] uppercase tracking-wide">Outbound</span>
                    {stats.outbound.map((e) => (
                        <div key={`o-${e.to}`}>
                            <div className="flex justify-between gap-2">
                                <span className="truncate text-muted-foreground">
                                    <span className="text-blue-400">&rarr;</span>{" "}{e.to}
                                </span>
                                <span className="shrink-0 tabular-nums">&times;{e.weight}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {stats.inbound.length > 0 && (
                <div className="mt-2 space-y-px border-t border-border/30 pt-2">
                    <span className="text-muted-foreground text-[10px] uppercase tracking-wide">Inbound</span>
                    {stats.inbound.map((e) => (
                        <div key={`i-${e.from}`}>
                            <div className="flex justify-between gap-2">
                                <span className="truncate text-muted-foreground">
                                    <span className="text-emerald-400">&larr;</span>{" "}{e.from}
                                </span>
                                <span className="shrink-0 tabular-nums">&times;{e.weight}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 border-t border-border/30 pt-2 text-muted-foreground">
                <span>First seen</span>
                <span className="text-right tabular-nums text-foreground">{fmtTime(node.firstSeen)}</span>
                <span>Last active</span>
                <span className="text-right tabular-nums text-foreground">{fmtTime(node.lastSeen)}</span>
            </div>
        </div>
    );
}
