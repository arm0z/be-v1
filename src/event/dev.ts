export type DevChannel =
  | "tap"
  | "adapter"
  | "normalizer"
  | "relay"
  | "aggregator"
  | "graph"
  | "sync"
  | "persistence";

export type DevEntry = {
  channel: DevChannel;
  event?: string;
  timestamp: number;
  source?: string;
  message: string;
  data?: unknown;
};

function createDevLog() {
  if (!import.meta.env.DEV) {
    return (
      _channel: DevChannel,
      _event: string,
      _message: string,
      _data?: unknown,
    ) => {};
  }

  return (
    channel: DevChannel,
    event: string,
    message: string,
    data?: unknown,
  ) => {
    const entry: DevEntry = {
      channel,
      event,
      timestamp: Date.now(),
      message,
      data,
    };
    chrome.runtime.sendMessage({ type: "dev:log", entry });
  };
}

export const dev = { log: createDevLog() };
