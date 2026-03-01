import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Box, GitGraph, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { GraphView } from "./panels/GraphView";
import { LogStream } from "./panels/LogStream";
import { StateInspector } from "./panels/StateInspector";
import { useDevPort } from "./useDevPort";

const tabs = [
	{ id: "graph", label: "Graph", icon: GitGraph },
	{ id: "logs", label: "Logs", icon: ScrollText },
	{ id: "state", label: "State", icon: Box },
] as const;

function useHashTab() {
	const [active, setActive] = useState(() => {
		const hash = window.location.hash.slice(1);
		return tabs.some((t) => t.id === hash) ? hash : "graph";
	});

	useEffect(() => {
		function onHashChange() {
			const hash = window.location.hash.slice(1);
			if (tabs.some((t) => t.id === hash)) setActive(hash);
		}
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	return active;
}

export default function App() {
	const active = useHashTab();
	const { entries, filter, setEventFilter, clear } = useDevPort();

	return (
		<div className="flex h-screen flex-col bg-background text-foreground">
			<Tabs
				value={active}
				onValueChange={(v) => {
					window.location.hash = v;
				}}
				className="shrink-0 border-b"
			>
				<TabsList variant="line" className="px-4">
					{tabs.map((tab) => (
						<TabsTrigger key={tab.id} value={tab.id}>
							<tab.icon className="h-4 w-4" />
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			<div className={cn("flex-1", active === "logs" || active === "graph" || active === "state" ? "overflow-hidden" : "dev-scrollbar overflow-auto p-4")}>
				{active === "graph" && <GraphView entries={entries} />}
				{active === "logs" && (
					<LogStream
						entries={entries}
						onClear={clear}
						filter={filter}
						setEventFilter={setEventFilter}
					/>
				)}
				{active === "state" && <StateInspector entries={entries} />}
			</div>
		</div>
	);
}
