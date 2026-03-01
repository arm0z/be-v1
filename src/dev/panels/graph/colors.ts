export const COMMUNITY_COLORS = [
    "hsl(210, 80%, 60%)",
    "hsl(150, 70%, 50%)",
    "hsl(30, 90%, 60%)",
    "hsl(280, 70%, 60%)",
    "hsl(0, 80%, 60%)",
    "hsl(60, 80%, 50%)",
    "hsl(180, 70%, 50%)",
    "hsl(330, 70%, 60%)",
];

export function getCommunityColor(communityId: string, communityIds: string[]): string {
    const index = communityIds.indexOf(communityId);
    return COMMUNITY_COLORS[index % COMMUNITY_COLORS.length];
}

export function convexHull(points: [number, number][]): [number, number][] {
    if (points.length < 3) return points;
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    function cross(o: [number, number], a: [number, number], b: [number, number]): number {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }

    const lower: [number, number][] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop();
        }
        lower.push(p);
    }

    const upper: [number, number][] = [];
    for (const p of [...sorted].reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop();
        }
        upper.push(p);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
}
