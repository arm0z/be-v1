import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export async function writeClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

export function hslAlpha(hsl: string, alpha: number): string {
    const m = hsl.match(/^hsl\(([^)]+)\)$/);
    if (!m) return hsl;
    return `hsla(${m[1]}, ${alpha})`;
}
