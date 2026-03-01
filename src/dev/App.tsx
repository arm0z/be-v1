import {
    DockviewReact,
    type DockviewReadyEvent,
    type DockviewTheme,
    type IDockviewHeaderActionsProps,
    type IDockviewPanelProps,
} from "dockview";
import {
    Box,
    ExternalLink,
    GitGraph,
    Maximize2,
    Menu,
    Minimize2,
    ScrollText,
    X,
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactElement,
} from "react";
import { DevContext, useDevContext } from "./DevContext";
import { GraphView } from "./panels/GraphView";
import { LogStream } from "./panels/LogStream";
import { StateInspector } from "./panels/StateInspector";
import { useDevPort } from "./useDevPort";

/* ── panel wrappers (consume shared state via context) ────────── */

function GraphPanel(_props: IDockviewPanelProps) {
    const { entries, clear } = useDevContext();
    return <GraphView entries={entries} onClear={clear} />;
}

function LogsPanel(_props: IDockviewPanelProps) {
    const { entries, filter, setEventFilter } = useDevContext();
    return (
        <LogStream
            entries={entries}
            filter={filter}
            setEventFilter={setEventFilter}
        />
    );
}

function StatePanel(_props: IDockviewPanelProps) {
    const { entries, clear } = useDevContext();
    return <StateInspector entries={entries} onClear={clear} />;
}

/* ── tab icon renderer ────────────────────────────────────────── */

const iconMap: Record<string, ReactElement> = {
    graph: <GitGraph className="mr-1.5 h-3.5 w-3.5" />,
    logs: <ScrollText className="mr-1.5 h-3.5 w-3.5" />,
    state: <Box className="mr-1.5 h-3.5 w-3.5" />,
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
    { type: "state", component: "state", title: "State" },
] as const;

let nextId = 0;

/* ── header menu ──────────────────────────────────────────────── */

const menuItemCls =
    "flex w-full items-center gap-2 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800";

function RightActions({
    api,
    containerApi,
    group,
}: IDockviewHeaderActionsProps) {
    const [open, setOpen] = useState(false);
    const [maximized, setMaximized] = useState(api.isMaximized());
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node))
                setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

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
        setOpen(false);
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
        <div ref={ref} className="relative flex items-center gap-0.5 pr-1">
            <button className={btnCls} onClick={toggleMaximize} title={maximized ? "Restore" : "Maximize"}>
                {maximized ? (
                    <Minimize2 className="h-3.5 w-3.5 text-neutral-400" />
                ) : (
                    <Maximize2 className="h-3.5 w-3.5 text-neutral-400" />
                )}
            </button>
            <button className={btnCls} onClick={popOut} title="Pop out">
                <ExternalLink className="h-3.5 w-3.5 text-neutral-400" />
            </button>
            <button
                className={btnCls}
                onClick={() => setOpen((o) => !o)}
            >
                <Menu className="h-3.5 w-3.5 text-neutral-400" />
            </button>
            {open && (
                <div className="absolute right-0 top-full z-50 mt-1 min-w-36 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg">
                    {panelDefs.map((def) => (
                        <button
                            key={def.type}
                            className={menuItemCls}
                            onClick={() => addPanel(def)}
                        >
                            {iconMap[def.type]}
                            Add {def.title}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/* ── component registry ───────────────────────────────────────── */

const components = {
    graph: GraphPanel,
    logs: LogsPanel,
    state: StatePanel,
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
        <DevContext.Provider value={port}>
            <DockviewReact
                theme={neutralTheme}
                components={components}
                tabComponents={tabComponents}
                rightHeaderActionsComponent={headerActions.right}
                onReady={onReady}
            />
        </DevContext.Provider>
    );
}
