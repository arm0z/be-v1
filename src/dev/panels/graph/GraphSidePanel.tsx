import type { DirectedGraph, LouvainResult, PreprocessResult } from "@/aggregation/types";
import type { Dispatch, SetStateAction } from "react";

import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { getCommunityColor } from "./colors";

type GroupedResult = {
    pr: PreprocessResult;
    graph: DirectedGraph;
    louvain: LouvainResult;
};

type CommunityBreakdown = {
    communities: Map<string, string[]>;
    uniqueIds: string[];
};

type Props = {
    activeTab: "raw" | "grouped";
    panelWidth: number;
    onPanelWidthChange: Dispatch<SetStateAction<number>>;
    groupedResult: GroupedResult | null;
    communityBreakdown: CommunityBreakdown | null;
    latestTransitionsCount: number;
    nodesCount: number;
    edgesCount: number;
    // Algorithm params
    resolution: number;
    setResolution: Dispatch<SetStateAction<number>>;
    hubThreshold: number;
    setHubThreshold: Dispatch<SetStateAction<number>>;
    hubMinSources: number;
    setHubMinSources: Dispatch<SetStateAction<number>>;
    sentinelPassthroughMs: number;
    setSentinelPassthroughMs: Dispatch<SetStateAction<number>>;
    sentinelBreakMs: number;
    setSentinelBreakMs: Dispatch<SetStateAction<number>>;
    transientDwellMs: number;
    setTransientDwellMs: Dispatch<SetStateAction<number>>;
    targetPerChunk: number;
    setTargetPerChunk: Dispatch<SetStateAction<number>>;
};

export function GraphSidePanel({
    activeTab, panelWidth, onPanelWidthChange,
    groupedResult, communityBreakdown,
    latestTransitionsCount, nodesCount, edgesCount,
    resolution, setResolution,
    hubThreshold, setHubThreshold,
    hubMinSources, setHubMinSources,
    sentinelPassthroughMs, setSentinelPassthroughMs,
    sentinelBreakMs, setSentinelBreakMs,
    transientDwellMs, setTransientDwellMs,
    targetPerChunk, setTargetPerChunk,
}: Props) {
    return (
        <div className="relative flex h-full shrink-0 flex-col border-l border-border bg-background" style={{ width: panelWidth }}>
            {/* Resize handle */}
            <div
                className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-accent/50 active:bg-accent"
                onMouseDown={(e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const startWidth = panelWidth;
                    const onMove = (ev: MouseEvent) => {
                        const delta = startX - ev.clientX;
                        onPanelWidthChange(Math.max(200, Math.min(600, startWidth + delta)));
                    };
                    const onUp = () => {
                        document.removeEventListener("mousemove", onMove);
                        document.removeEventListener("mouseup", onUp);
                    };
                    document.addEventListener("mousemove", onMove);
                    document.addEventListener("mouseup", onUp);
                }}
            />
            <div className="border-b border-border px-3 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {activeTab === "grouped" ? "Algorithm Parameters" : "Graph Info"}
                </h3>
            </div>
            <div className="dev-scrollbar flex-1 overflow-y-auto p-3 space-y-4 text-xs">
                {activeTab === "grouped" ? (
                    <>
                        {/* Stats */}
                        {groupedResult && (
                            <div className="space-y-2">
                                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                    Results
                                </div>
                                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                                    <span className="text-muted-foreground">Modularity</span>
                                    <span className="text-right tabular-nums">
                                        {groupedResult.louvain.modularity.toFixed(4)}
                                    </span>
                                    <span className="text-muted-foreground">Communities</span>
                                    <span className="text-right tabular-nums">
                                        {new Set(groupedResult.louvain.communities.values()).size}
                                    </span>
                                    <span className="text-muted-foreground">Nodes</span>
                                    <span className="text-right tabular-nums">
                                        {groupedResult.graph.nodes.size}
                                    </span>
                                    <span className="text-muted-foreground">Edges</span>
                                    <span className="text-right tabular-nums">
                                        {groupedResult.graph.edges.size}
                                    </span>
                                    <span className="text-muted-foreground">Hubs</span>
                                    <span className="text-right tabular-nums">
                                        {groupedResult.pr.hubSources.size}
                                    </span>
                                    <span className="text-muted-foreground">Sentinels</span>
                                    <span className="text-right tabular-nums">
                                        {groupedResult.pr.sentinelCount}
                                    </span>
                                    <span className="text-muted-foreground">Excluded</span>
                                    <span className="text-right tabular-nums">
                                        {groupedResult.pr.excludedSources.size}
                                    </span>
                                </div>
                            </div>
                        )}
                        <Separator />

                        {/* Louvain */}
                        <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Louvain</div>
                            <div>
                                <div className="flex justify-between text-muted-foreground">
                                    <span>Resolution ({"\u03B3"})</span>
                                    <span className="tabular-nums">{resolution.toFixed(2)}</span>
                                </div>
                                <Slider min={0.1} max={3.0} step={0.05} value={[resolution]} onValueChange={([v]) => setResolution(v)} className="mt-1" />
                                <div className="flex justify-between text-muted-foreground text-[10px]">
                                    <span>0.1 (larger)</span>
                                    <span>3.0 (smaller)</span>
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground/60">Controls community granularity. Lower values merge more sources into fewer, larger groups. Higher values split into many smaller groups.</p>
                            </div>
                        </div>
                        <Separator />

                        {/* Off-browser */}
                        <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Off-browser sentinel</div>
                            <div>
                                <div className="flex justify-between text-muted-foreground">
                                    <span>Pass-through</span>
                                    <span className="tabular-nums">{(sentinelPassthroughMs / 1000).toFixed(1)}s</span>
                                </div>
                                <Slider min={500} max={10000} step={500} value={[sentinelPassthroughMs]} onValueChange={([v]) => setSentinelPassthroughMs(v)} className="mt-1" />
                                <p className="mt-1 text-xs text-muted-foreground/60">Off-browser stints shorter than this are collapsed into a direct A{"\u2192"}B edge. Filters notification popups and accidental focus loss.</p>
                            </div>
                            <div>
                                <div className="flex justify-between text-muted-foreground">
                                    <span>Break boundary</span>
                                    <span className="tabular-nums">{(sentinelBreakMs / 60000).toFixed(0)} min</span>
                                </div>
                                <Slider min={60000} max={1800000} step={60000} value={[sentinelBreakMs]} onValueChange={([v]) => setSentinelBreakMs(v)} className="mt-1" />
                                <p className="mt-1 text-xs text-muted-foreground/60">Off-browser stints longer than this sever the graph link entirely. Treats long absences (lunch, meetings) as task boundaries.</p>
                            </div>
                        </div>
                        <Separator />

                        {/* Transient */}
                        <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transient detection</div>
                            <div>
                                <div className="flex justify-between text-muted-foreground">
                                    <span>Dwell threshold</span>
                                    <span className="tabular-nums">{transientDwellMs}ms</span>
                                </div>
                                <Slider min={100} max={2000} step={100} value={[transientDwellMs]} onValueChange={([v]) => setTransientDwellMs(v)} className="mt-1" />
                                <p className="mt-1 text-xs text-muted-foreground/60">Sources where every visit was shorter than this are removed as transient. Filters rapid tab scanning (Ctrl+Tab).</p>
                            </div>
                        </div>
                        <Separator />

                        {/* Hub detection */}
                        <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Hub detection</div>
                            <div>
                                <div className="flex justify-between text-muted-foreground">
                                    <span>Threshold</span>
                                    <span className="tabular-nums">{(hubThreshold * 100).toFixed(0)}%</span>
                                </div>
                                <Slider min={0.05} max={0.5} step={0.01} value={[hubThreshold]} onValueChange={([v]) => setHubThreshold(v)} className="mt-1" />
                                <p className="mt-1 text-xs text-muted-foreground/60">A source is a hub if its neighbor count exceeds this % of total sources. Hubs (e.g. email, Slack) are split into time chunks instead of dominating one community.</p>
                            </div>
                            <div>
                                <div className="flex justify-between text-muted-foreground">
                                    <span>Min sources</span>
                                    <span className="tabular-nums">{hubMinSources}</span>
                                </div>
                                <Slider min={3} max={30} step={1} value={[hubMinSources]} onValueChange={([v]) => setHubMinSources(v)} className="mt-1" />
                                <p className="mt-1 text-xs text-muted-foreground/60">Hub detection only activates when total unique sources reaches this count. Prevents false hub detection in small graphs.</p>
                            </div>
                            <div>
                                <div className="flex justify-between text-muted-foreground">
                                    <span>Target per chunk</span>
                                    <span className="tabular-nums">{targetPerChunk}</span>
                                </div>
                                <Slider min={2} max={10} step={1} value={[targetPerChunk]} onValueChange={([v]) => setTargetPerChunk(v)} className="mt-1" />
                                <p className="mt-1 text-xs text-muted-foreground/60">Target transitions per hub chunk. Drives the dynamic window size — fewer means finer-grained time slicing of hub sources.</p>
                            </div>
                        </div>
                        <Separator />

                        {/* Per-community breakdown */}
                        {communityBreakdown && (
                            <div className="space-y-2">
                                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Communities</div>
                                {[...communityBreakdown.communities.entries()].map(([communityId, members]) => (
                                    <div key={communityId} className="rounded border border-border/50 p-2">
                                        <div className="flex items-center gap-2">
                                            <div
                                                className="h-2.5 w-2.5 rounded-full"
                                                style={{ backgroundColor: getCommunityColor(communityId, communityBreakdown.uniqueIds) }}
                                            />
                                            <span className="font-medium">{members.length} nodes</span>
                                        </div>
                                        <div className="mt-1 space-y-px">
                                            {members.map(id => (
                                                <div key={id} className="truncate text-muted-foreground">{id}</div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                ) : (
                    <div className="space-y-3">
                        <div>
                            <div className="text-muted-foreground">Transitions</div>
                            <div className="text-lg tabular-nums">{latestTransitionsCount}</div>
                        </div>
                        <div>
                            <div className="text-muted-foreground">Nodes</div>
                            <div className="text-lg tabular-nums">{nodesCount}</div>
                        </div>
                        <div>
                            <div className="text-muted-foreground">Edges</div>
                            <div className="text-lg tabular-nums">{edgesCount}</div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
