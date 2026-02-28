// ── Primitives ──────────────────────────────────────────────

export type Capture = {
  kind: string;
  context: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

export type Teardown = () => void;

// ── Pipeline stages ─────────────────────────────────────────

/** Base layer. Hooks into the DOM and streams Captures to a sink. */
export type Tap = (sink: (capture: Capture) => void) => Teardown;

/** Middleware. Wraps a Tap, may inject/filter/transform Captures. */
export type Adapter = (inner: Tap) => Tap;

/** Middleware. Wraps a Tap, aggregates/deduplicates Captures. */
export type Normalizer = (inner: Tap) => Tap;

/** Terminal. Wraps a Tap, forwards Captures to the service worker. */
export type Relay = (inner: Tap) => Teardown;

// ── Routing ─────────────────────────────────────────────────

export type Route = {
  match: (url: string) => boolean;
  build: () => Teardown;
};
