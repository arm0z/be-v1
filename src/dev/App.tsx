import { cn } from "@/lib/utils";
import { GitGraph, ScrollText, SlidersHorizontal, Variable } from "lucide-react";
import { useEffect, useState } from "react";
import { FilterToggles } from "./panels/FilterToggles";
import { GraphView } from "./panels/GraphView";
import { LogStream } from "./panels/LogStream";
import { StateInspector } from "./panels/StateInspector";

const tabs = [
	{ id: "graph", label: "Graph", icon: GitGraph, panel: GraphView },
	{ id: "logs", label: "Logs", icon: ScrollText, panel: LogStream },
	{ id: "state", label: "State", icon: Variable, panel: StateInspector },
	{ id: "filters", label: "Filters", icon: SlidersHorizontal, panel: FilterToggles },
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
	const ActivePanel = tabs.find((t) => t.id === active)!.panel;

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
			<div className="flex-1 overflow-auto p-4">
				<ActivePanel />
			</div>
		</div>
	);
}
