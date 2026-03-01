import type { DevEntry } from "@/event/dev";
import {
    Check,
    CircleOff,
    Clock,
    HardDrive,
    Package,
    RefreshCw,
    RotateCcw,
    Send,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

const ico = "size-4";

/**
 * Watches incoming DevEntry stream for operation-related events
 * and fires toast notifications so no operation is silent.
 */
export function useDevToasts(entries: DevEntry[]): void {
    const processedRef = useRef(0);

    useEffect(() => {
        if (entries.length < processedRef.current) {
            processedRef.current = 0;
            return;
        }

        const newCount = entries.length - processedRef.current;
        if (newCount > 10) {
            // Large batch — likely a replay or reconnect, skip toasting
            processedRef.current = entries.length;
            return;
        }

        for (let i = processedRef.current; i < entries.length; i++) {
            const e = entries[i];
            if (!e.event) continue;

            switch (e.event) {
                case "sync.flush": {
                    const data = e.data as {
                        packet?: {
                            id: string;
                            groups: unknown[];
                        } | null;
                    } | undefined;
                    if (data?.packet) {
                        toast(
                            `Packet flushed — ${data.packet.id.slice(0, 8)}... (${data.packet.groups.length} groups)`,
                            { icon: <Package className={ico} /> },
                        );
                    } else {
                        toast("Nothing to flush", {
                            icon: <CircleOff className={ico} />,
                        });
                    }
                    break;
                }

                case "sync.send":
                    toast("Sync triggered", {
                        icon: <Upload className={ico} />,
                    });
                    break;

                case "sync.sent":
                    toast("Sync complete", {
                        icon: <Check className={ico} />,
                    });
                    break;

                case "sync.failed":
                    toast("Sync failed — " + e.message, {
                        icon: <X className={ico} />,
                    });
                    break;

                case "sync.drain_retry":
                    toast("Draining retry queue", {
                        icon: <RotateCcw className={ico} />,
                    });
                    break;

                case "retry.expired":
                    toast("Retry expired — " + e.message, {
                        icon: <Clock className={ico} />,
                    });
                    break;

                case "state.reset":
                    toast("State cleared", {
                        icon: <Trash2 className={ico} />,
                    });
                    break;

                case "checkpoint.written":
                    toast("Checkpoint saved", {
                        icon: <HardDrive className={ico} />,
                    });
                    break;

                case "checkpoint.suspend":
                    toast("Checkpoint saved on suspend", {
                        icon: <HardDrive className={ico} />,
                    });
                    break;

                case "checkpoint.recovered":
                    toast("Checkpoint restored", {
                        icon: <RefreshCw className={ico} />,
                    });
                    break;

                case "checkpoint.cleared":
                    toast("Checkpoint cleared", {
                        icon: <Trash2 className={ico} />,
                    });
                    break;

                case "packet.ready":
                    toast("Packet ready — " + e.message, {
                        icon: <Send className={ico} />,
                    });
                    break;
            }
        }

        processedRef.current = entries.length;
    }, [entries]);
}
