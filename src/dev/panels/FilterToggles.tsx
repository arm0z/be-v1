import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useState } from "react";
import type { DevChannel } from "@/event/dev";

const channels: { id: DevChannel; defaultOn: boolean }[] = [
	{ id: "tap", defaultOn: true },
	{ id: "adapter", defaultOn: true },
	{ id: "normalizer", defaultOn: true },
	{ id: "relay", defaultOn: false },
	{ id: "aggregator", defaultOn: true },
	{ id: "graph", defaultOn: true },
	{ id: "sync", defaultOn: true },
	{ id: "persistence", defaultOn: true },
];

export function FilterToggles() {
	const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
		Object.fromEntries(channels.map((ch) => [ch.id, ch.defaultOn])),
	);

	function toggle(id: string) {
		setEnabled((prev) => ({ ...prev, [id]: !prev[id] }));
	}

	return (
		<div className="space-y-3">
			{channels.map((ch) => (
				<div
					key={ch.id}
					className="flex items-center justify-between rounded-md border p-3"
				>
					<Label htmlFor={ch.id} className="text-sm capitalize">
						{ch.id}
					</Label>
					<Switch
						id={ch.id}
						checked={enabled[ch.id]}
						onCheckedChange={() => toggle(ch.id)}
					/>
				</div>
			))}
		</div>
	);
}
