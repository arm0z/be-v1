import { createContext, useContext } from "react";

import type { DevEntry } from "@/event/dev";
import type { DevFilter } from "./useDevPort";

export type DevCtx = {
    entries: DevEntry[];
    filter: DevFilter | null;
    setEventFilter: (events: Partial<Record<string, boolean>>) => void;
    clear: () => void;
};

export const DevContext = createContext<DevCtx>(null!);

export function useDevContext() {
    return useContext(DevContext);
}
