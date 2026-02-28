const placeholderState = [
	{ key: "Active Source", value: "—" },
	{ key: "Open Bundle", value: "—" },
	{ key: "Sealed Count", value: "0" },
	{ key: "Edges", value: "0" },
];

export function StateInspector() {
	return (
		<div className="space-y-3">
			{placeholderState.map((item) => (
				<div
					key={item.key}
					className="flex items-center justify-between rounded-md border p-3 text-sm"
				>
					<span className="text-muted-foreground">{item.key}</span>
					<span className="font-mono">{item.value}</span>
				</div>
			))}
		</div>
	);
}
