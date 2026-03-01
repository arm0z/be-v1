import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";

// Reset counter: toggling between even/odd controls expand-all vs collapse-all.
// Incrementing by 2 keeps the parity, +1 flips it. Changing the key on <JsonNode>
// forces React to remount the subtree with the new default-open state.
export type TreeReset = number;

export function PrimitiveValue({ value }: { value: unknown }) {
    if (value === null)
        return <span className="text-muted-foreground italic">null</span>;
    if (typeof value === "string")
        return <span className="text-green-400">"{value}"</span>;
    if (typeof value === "number")
        return <span className="text-blue-400">{value}</span>;
    if (typeof value === "boolean")
        return <span className="text-amber-400">{String(value)}</span>;
    return <span>{String(value)}</span>;
}

export function JsonNode({
    label,
    value,
    depth = 0,
    reset,
}: {
    label?: string;
    value: unknown;
    depth?: number;
    reset: TreeReset;
}) {
    const isObject = value !== null && typeof value === "object";
    const isArray = Array.isArray(value);

    const expandAll = reset % 2 === 1;
    const defaultOpen = expandAll || depth < 2;
    const [open, setOpen] = useState(defaultOpen);

    if (!isObject) {
        return (
            <div className="flex items-baseline gap-1.5 py-px">
                {label != null && (
                    <span className="text-muted-foreground shrink-0">
                        {label}:
                    </span>
                )}
                <PrimitiveValue value={value} />
            </div>
        );
    }

    const entries: [string, unknown][] = isArray
        ? value.map((v, i) => [String(i), v] as [string, unknown])
        : Object.entries(value as Record<string, unknown>);
    const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;

    if (entries.length === 0) {
        return (
            <div className="flex items-baseline gap-1.5 py-px">
                {label != null && (
                    <span className="text-muted-foreground shrink-0">
                        {label}:
                    </span>
                )}
                <span className="text-muted-foreground">
                    {isArray ? "[]" : "{}"}
                </span>
            </div>
        );
    }

    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="-ml-1 flex items-baseline gap-1.5 rounded px-1 py-px hover:bg-muted/30"
            >
                <span className="w-2.5 shrink-0 text-[10px] text-muted-foreground">
                    {open ? "\u25BC" : "\u25B6"}
                </span>
                {label != null && (
                    <span className="text-muted-foreground">{label}:</span>
                )}
                {!open && (
                    <span className="text-muted-foreground/60">{summary}</span>
                )}
            </button>
            {open && (
                <div className="ml-2 border-l border-border/50 pl-3">
                    {entries.map(([k, v]) => (
                        <JsonNode
                            key={k}
                            label={k}
                            value={v}
                            depth={depth + 1}
                            reset={reset}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export function JsonTreeView({ data }: { data: unknown }) {
    const [reset, setReset] = useState(0);
    const collapseAll = useCallback(
        () => setReset((r) => (r % 2 === 0 ? r + 2 : r + 1)),
        [],
    );
    const expandAll = useCallback(
        () => setReset((r) => (r % 2 === 1 ? r + 2 : r + 1)),
        [],
    );

    return (
        <div className="font-mono text-sm">
            <div className="mb-3 flex items-center justify-end gap-1">
                <Button variant="ghost" size="xs" onClick={expandAll}>
                    <ChevronsUpDown className="h-3 w-3" />
                    Expand all
                </Button>
                <Button variant="ghost" size="xs" onClick={collapseAll}>
                    <ChevronsDownUp className="h-3 w-3" />
                    Collapse all
                </Button>
            </div>
            <JsonNode key={reset} value={data} reset={reset} />
        </div>
    );
}
