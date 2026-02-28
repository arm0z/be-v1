import { cn } from "@/lib/utils";
import { GitGraph, ScrollText, SlidersHorizontal, Variable } from "lucide-react";
import { useEffect, useState } from "react";
import { FilterToggles } from "./panels/FilterToggles";
import { GraphView } from "./panels/GraphView";
import { LogStream } from "./panels/LogStream";
import { StateInspector } from "./panels/StateInspector";
import { useDevPort } from "./useDevPort";

const tabs = [
	{ id: "graph", label: "Graph", icon: GitGraph },
	{ id: "logs", label: "Logs", icon: ScrollText },
	{ id: "state", label: "State", icon: Variable },
	{ id: "filters", label: "Filters", icon: SlidersHorizontal },
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
	const { entries, filter, setChannelFilter, setEventFilter, clear } =
		useDevPort();

	return (
		<div className="flex h-screen flex-col bg-background text-foreground">
			<nav className="flex items-center gap-4 border-b px-4 py-2">
				{tabs.map((tab) => (
					<a
						key={tab.id}
						href={`#${tab.id}`}
						className={cn(
							"inline-flex items-center gap-2 py-1.5 font-medium underline-offset-4 transition-colors hover:underline",
							active === tab.id
								? "text-foreground underline"
								: "text-muted-foreground",
						)}
					>
						<tab.icon className="h-4 w-4" />
						{tab.label}
					</a>
				))}
			</nav>
			<div className={cn("flex-1", active === "logs" || active === "graph" ? "overflow-hidden" : "overflow-auto p-4")}>
				{active === "graph" && <GraphView entries={entries} />}
				{active === "logs" && (
					<LogStream entries={entries} onClear={clear} />
				)}
				{active === "state" && <StateInspector />}
				{active === "filters" && (
					<FilterToggles
						filter={filter}
						setEventFilter={setEventFilter}
					/>
				)}
			</div>
		</div>
	);
}
