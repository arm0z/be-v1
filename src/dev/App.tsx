import {
    DockviewReact,
    type DockviewReadyEvent,
    type IDockviewPanelProps,
} from "dockview";
import { Box, GitGraph, ScrollText } from "lucide-react";
import { useCallback, type ReactElement } from "react";
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

function TabIcon({ api }: IDockviewPanelProps) {
    return (
        <div className="flex items-center px-1.5">
            {iconMap[api.id]}
            <span>{api.title}</span>
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

/* ── main app ─────────────────────────────────────────────────── */

export default function App() {
    const port = useDevPort();

    const onReady = useCallback((event: DockviewReadyEvent) => {
        event.api.addPanel({
            id: "graph",
            component: "graph",
            tabComponent: "tab",
            title: "Graph",
        });

        event.api.addPanel({
            id: "logs",
            component: "logs",
            tabComponent: "tab",
            title: "Log",
        });

        event.api.addPanel({
            id: "state",
            component: "state",
            tabComponent: "tab",
            title: "State",
        });
    }, []);

    return (
        <DevContext.Provider value={port}>
            <DockviewReact
                className="dockview-theme-neutral"
                components={components}
                tabComponents={tabComponents}
                onReady={onReady}
            />
        </DevContext.Provider>
    );
}
