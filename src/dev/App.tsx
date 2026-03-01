import {
    DockviewReact,
    type DockviewReadyEvent,
    type DockviewTheme,
    type IDockviewHeaderActionsProps,
    type IDockviewPanelProps,
} from "dockview";
import {
    ExternalLink,
    GitGraph,
    HardDrive,
    Maximize2,
    Menu,
    Minimize2,
    Package,
    ScrollText,
    X,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCallback, useState, type ReactElement } from "react";
import { DevContext, useDevContext } from "./DevContext";
import { ErrorBoundary } from "./ErrorBoundary";
import { GraphView } from "./panels/GraphView";
import { LogStream } from "./panels/LogStream";
import { PacketInspector } from "./panels/PacketInspector";
import { CheckpointInspector } from "./panels/CheckpointInspector";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDevPort } from "./useDevPort";
import { useDevToasts } from "./useDevToasts";

/* ── panel wrappers (consume shared state via context) ────────── */

function GraphPanel(_props: IDockviewPanelProps) {
    const { entries, send, clear } = useDevContext();
    return (
        <ErrorBoundary>
            <GraphView entries={entries} onSend={send} onClear={clear} />
        </ErrorBoundary>
    );
}

function LogsPanel(_props: IDockviewPanelProps) {
    const { entries, filter, setChannelFilter, setEventFilter } =
        useDevContext();
    return (
        <ErrorBoundary>
            <LogStream
                entries={entries}
                filter={filter}
                setChannelFilter={setChannelFilter}
                setEventFilter={setEventFilter}
            />
        </ErrorBoundary>
    );
}

function PacketPanel(_props: IDockviewPanelProps) {
    const { entries, send } = useDevContext();
    return (
        <ErrorBoundary>
            <PacketInspector entries={entries} onSend={send} />
        </ErrorBoundary>
    );
}

function CheckpointPanel(_props: IDockviewPanelProps) {
    const { send } = useDevContext();
    return (
        <ErrorBoundary>
            <CheckpointInspector onSend={send} />
        </ErrorBoundary>
    );
}

/* ── tab icon renderer ────────────────────────────────────────── */

const iconMap: Record<string, ReactElement> = {
    graph: <GitGraph className="mr-1.5 h-3.5 w-3.5" />,
    logs: <ScrollText className="mr-1.5 h-3.5 w-3.5" />,
    packet: <Package className="mr-1.5 h-3.5 w-3.5" />,
    checkpoint: <HardDrive className="mr-1.5 h-3.5 w-3.5" />,
};

function TabIcon({ api, params }: IDockviewPanelProps) {
    const panelType = (params.panelType as string) ?? api.id;
    return (
        <div className="group/tab flex items-center gap-1 px-1.5">
            <span className="flex items-center">
                {iconMap[panelType]}
                {api.title}
            </span>
            <button
                className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-neutral-600 group-hover/tab:opacity-100"
                onClick={(e) => {
                    e.stopPropagation();
                    api.close();
                }}
            >
                <X className="h-3.5 w-3.5 text-neutral-400" />
            </button>
        </div>
    );
}

/* ── panel definitions & id counter ───────────────────────────── */

const panelDefs = [
    { type: "graph", component: "graph", title: "Graph" },
    { type: "logs", component: "logs", title: "Log" },
    { type: "packet", component: "packet", title: "Packet" },
    { type: "checkpoint", component: "checkpoint", title: "Checkpoint" },
] as const;

// Module-level counter for unique panel IDs. Under StrictMode double-mount,
// IDs may be non-sequential — this is cosmetic-only with no functional impact.
let nextId = 0;

/* ── header menu ──────────────────────────────────────────────── */

function RightActions({
    api,
    containerApi,
    group,
}: IDockviewHeaderActionsProps) {
    const [maximized, setMaximized] = useState(api.isMaximized());

    const addPanel = (def: (typeof panelDefs)[number]) => {
        const id = `${def.type}-${++nextId}`;
        containerApi.addPanel({
            id,
            component: def.component,
            tabComponent: "tab",
            title: def.title,
            params: { panelType: def.type },
            position: { referenceGroup: group },
        });
    };

    const toggleMaximize = () => {
        if (api.isMaximized()) {
            api.exitMaximized();
            setMaximized(false);
        } else {
            api.maximize();
            setMaximized(true);
        }
    };

    const popOut = () => {
        containerApi.addPopoutGroup(group);
    };

    const btnCls =
        "flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-700";

    return (
        <div className="flex items-center gap-0.5 pr-1">
            <Tooltip>
                <TooltipTrigger asChild>
                    <button className={btnCls} onClick={toggleMaximize}>
                        {maximized ? (
                            <Minimize2 className="h-3.5 w-3.5 text-neutral-400" />
                        ) : (
                            <Maximize2 className="h-3.5 w-3.5 text-neutral-400" />
                        )}
                    </button>
                </TooltipTrigger>
                <TooltipContent>
                    {maximized ? "Restore" : "Maximize"}
                </TooltipContent>
            </Tooltip>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button className={btnCls} onClick={popOut}>
                        <ExternalLink className="h-3.5 w-3.5 text-neutral-400" />
                    </button>
                </TooltipTrigger>
                <TooltipContent>Pop out</TooltipContent>
            </Tooltip>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button className={btnCls}>
                        <Menu className="h-3.5 w-3.5 text-neutral-400" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {panelDefs.map((def) => (
                        <DropdownMenuItem
                            key={def.type}
                            onClick={() => addPanel(def)}
                        >
                            {iconMap[def.type]}
                            {def.title}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

/* ── component registry ───────────────────────────────────────── */

const components = {
    graph: GraphPanel,
    logs: LogsPanel,
    packet: PacketPanel,
    checkpoint: CheckpointPanel,
};

const tabComponents = {
    tab: TabIcon,
};

const headerActions = {
    right: RightActions,
};

/* ── theme ────────────────────────────────────────────────────── */

const neutralTheme: DockviewTheme = {
    name: "neutral",
    className: "dockview-theme-neutral",
};

/* ── main app ─────────────────────────────────────────────────── */

export default function App() {
    const port = useDevPort();
    useDevToasts(port.entries);

    const onReady = useCallback((event: DockviewReadyEvent) => {
        for (const def of panelDefs) {
            const id = `${def.type}-${++nextId}`;
            event.api.addPanel({
                id,
                component: def.component,
                tabComponent: "tab",
                title: def.title,
                params: { panelType: def.type },
            });
        }

        // always keep at least one tab open
        event.api.onDidRemovePanel(() => {
            if (event.api.totalPanels === 0) {
                const def = panelDefs[0];
                event.api.addPanel({
                    id: `${def.type}-${++nextId}`,
                    component: def.component,
                    tabComponent: "tab",
                    title: def.title,
                    params: { panelType: def.type },
                });
            }
        });
    }, []);

    return (
        <TooltipProvider>
            <DevContext.Provider value={port}>
                <DockviewReact
                    theme={neutralTheme}
                    components={components}
                    tabComponents={tabComponents}
                    rightHeaderActionsComponent={headerActions.right}
                    onReady={onReady}
                />
                <Toaster
                    theme="dark"
                    position="bottom-right"
                    toastOptions={{ duration: 3000 }}
                />
            </DevContext.Provider>
        </TooltipProvider>
    );
}
