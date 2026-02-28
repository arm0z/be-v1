import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

const sampleEntry = {
	channel: "tap" as const,
	event: "click",
	timestamp: Date.now(),
	message: "Button clicked on calendar view",
};

export function LogStream() {
	return (
		<ScrollArea className="h-full">
			<div className="space-y-2">
				<div className="flex items-start gap-2 rounded-md border p-2 text-sm">
					<Badge variant="outline" className="shrink-0">
						{sampleEntry.channel}
					</Badge>
					<span className="text-muted-foreground">
						{new Date(sampleEntry.timestamp).toLocaleTimeString()}
					</span>
					<span>{sampleEntry.message}</span>
				</div>
				<p className="text-center text-sm text-muted-foreground">
					Waiting for log entries...
				</p>
			</div>
		</ScrollArea>
	);
}
