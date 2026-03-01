import { useCallback, useState } from "react";
import { writeClipboard } from "@/lib/utils";

export function useCopyFeedback(ms = 1500) {
    const [copied, setCopied] = useState(false);
    const copy = useCallback(
        async (text: string) => {
            if (await writeClipboard(text)) {
                setCopied(true);
                setTimeout(() => setCopied(false), ms);
            }
        },
        [ms],
    );
    return { copied, copy };
}
