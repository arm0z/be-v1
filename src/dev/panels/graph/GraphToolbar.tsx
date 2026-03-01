import {
    Boxes,
    Eclipse,
    Expand,
    PanelRight,
    Scan,
    Settings2,
    Shrink,
    Trash2,
    Waypoints,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MutableRefObject } from "react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { PhysicsParams } from "./types";
import {
    DEFAULT_CHARGE_K,
    DEFAULT_SPRING_K,
    DEFAULT_REST_LENGTH,
    DEFAULT_CENTER_K,
    DEFAULT_DAMPING,
    DEFAULT_PHYSICS,
} from "./types";

type Props = {
    activeTab: "raw" | "grouped";
    onTabChange: (tab: "raw" | "grouped") => void;
    isFullscreen: boolean;
    onToggleFullscreen: () => void;
    onFitToView: () => void;
    physicsOpen: boolean;
    onTogglePhysics: () => void;
    dimMode: boolean;
    onToggleDim: () => void;
    panelOpen: boolean;
    onTogglePanel: () => void;
    physics: PhysicsParams;
    physicsRef: MutableRefObject<PhysicsParams>;
    onPhysicsChange: (params: PhysicsParams) => void;
    awakeRef: MutableRefObject<boolean>;
    onClear?: () => void;
};

const PHYSICS_DEFS = [
    { label: "Repulsion", key: "chargeK" as const, min: 0, max: 3000, step: 50, def: DEFAULT_CHARGE_K },
    { label: "Spring", key: "springK" as const, min: 0, max: 0.1, step: 0.002, def: DEFAULT_SPRING_K },
    { label: "Rest length", key: "restLength" as const, min: 20, max: 400, step: 5, def: DEFAULT_REST_LENGTH },
    { label: "Centering", key: "centerK" as const, min: 0, max: 0.05, step: 0.001, def: DEFAULT_CENTER_K },
    { label: "Damping", key: "damping" as const, min: 0.5, max: 0.99, step: 0.01, def: DEFAULT_DAMPING },
];

export function GraphToolbar({
    activeTab, onTabChange,
    isFullscreen, onToggleFullscreen, onFitToView,
    physicsOpen, onTogglePhysics,
    dimMode, onToggleDim,
    panelOpen, onTogglePanel,
    physics, physicsRef, onPhysicsChange, awakeRef,
    onClear,
}: Props) {
    return (
        <>
            <Tabs
                value={activeTab}
                onValueChange={(v) => onTabChange(v as "raw" | "grouped")}
                className="absolute left-2 top-2 z-10"
            >
                <TabsList className="h-auto border border-border bg-popover/80 p-0.5 backdrop-blur-sm">
                    <TabsTrigger value="raw" className="h-auto px-2 py-0.5 text-xs">
                        <Waypoints className="size-3" />
                        Raw
                    </TabsTrigger>
                    <TabsTrigger value="grouped" className="h-auto px-2 py-0.5 text-xs">
                        <Boxes className="size-3" />
                        Grouped
                    </TabsTrigger>
                </TabsList>
            </Tabs>
            <div className="absolute right-2 top-2 flex gap-1">
                {onClear && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="outline" size="icon-xs" onClick={onClear}>
                                <Trash2 />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Clear all</TooltipContent>
                    </Tooltip>
                )}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={physicsOpen ? "default" : "outline"}
                            size="icon-xs"
                            onClick={onTogglePhysics}
                        >
                            <Settings2 />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{physicsOpen ? "Close physics" : "Physics settings"}</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={dimMode ? "default" : "outline"}
                            size="icon-xs"
                            onClick={onToggleDim}
                        >
                            <Eclipse />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{dimMode ? "Disable dim mode" : "Enable dim mode"}</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button variant="outline" size="icon-xs" onClick={onFitToView}>
                            <Scan />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Fit to view</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button variant="outline" size="icon-xs" onClick={onToggleFullscreen}>
                            {isFullscreen ? <Shrink /> : <Expand />}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{isFullscreen ? "Exit fullscreen" : "Fullscreen"}</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button variant="outline" size="icon-xs" onClick={onTogglePanel}>
                            <PanelRight />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{panelOpen ? "Close panel" : "Open panel"}</TooltipContent>
                </Tooltip>
            </div>
            {physicsOpen && (
                <div className="absolute bottom-2 left-2 z-10 w-56 rounded-lg border border-border/50 bg-popover/95 p-3 text-xs text-popover-foreground shadow-xl backdrop-blur-sm">
                    <div className="mb-2 font-semibold text-sm">Physics</div>
                    {PHYSICS_DEFS.map((p) => (
                        <div key={p.key} className="mt-1.5">
                            <div className="flex justify-between text-muted-foreground">
                                <span>{p.label}</span>
                                <span className="tabular-nums">{physics[p.key]}</span>
                            </div>
                            <Slider
                                min={p.min}
                                max={p.max}
                                step={p.step}
                                value={[physics[p.key]]}
                                onValueChange={([v]) => {
                                    physicsRef.current[p.key] = v;
                                    onPhysicsChange({ ...physicsRef.current });
                                    awakeRef.current = true;
                                }}
                                className="mt-1"
                            />
                        </div>
                    ))}
                    <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 w-full"
                        onClick={() => {
                            physicsRef.current = { ...DEFAULT_PHYSICS };
                            onPhysicsChange({ ...physicsRef.current });
                            awakeRef.current = true;
                        }}
                    >
                        Reset defaults
                    </Button>
                </div>
            )}
        </>
    );
}
