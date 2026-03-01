export type Node = {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    firstSeen: number;
    lastSeen: number;
};

export type Edge = { from: string; to: string; weight: number };

export type PhysicsParams = {
    chargeK: number;
    springK: number;
    restLength: number;
    centerK: number;
    damping: number;
};

export const DEFAULT_CHARGE_K = 800;
export const DEFAULT_SPRING_K = 0.02;
export const DEFAULT_REST_LENGTH = 120;
export const DEFAULT_CENTER_K = 0.005;
export const DEFAULT_DAMPING = 0.85;
export const MIN_DIST = 20;
export const ENERGY_THRESHOLD = 0.05;
export const NODE_RADIUS = 8;
export const HIT_RADIUS = 16;
export const DOT_SPACING = 24;
export const MAX_DOTS = 5000;

export const DEFAULT_PHYSICS: PhysicsParams = {
    chargeK: DEFAULT_CHARGE_K,
    springK: DEFAULT_SPRING_K,
    restLength: DEFAULT_REST_LENGTH,
    centerK: DEFAULT_CENTER_K,
    damping: DEFAULT_DAMPING,
};

export function fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}
