import { createContext, useContext } from "react";

import type { DevChannel, DevEntry, DevFilter } from "@/event/dev";

export type DevCtx = {
    entries: DevEntry[];
    filter: DevFilter | null;
    setChannelFilter: (channels: Partial<Record<DevChannel, boolean>>) => void;
    setEventFilter: (events: Partial<Record<string, boolean>>) => void;
    clear: () => void;
};

export const DevContext = createContext<DevCtx | null>(null);

export function useDevContext(): DevCtx {
    const ctx = useContext(DevContext);
    if (!ctx) throw new Error("useDevContext must be used within <DevContext.Provider>");
    return ctx;
}
