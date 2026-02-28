import type { Tap } from "./types.ts";
import { dev } from "./dev.ts";

/** Base Tap: attaches DOM listeners and streams Captures. */
export function tap(context = "root"): Tap {
  return (sink) => {
    const handle = (kind: string) => (e: Event) => {
      const capture = {
        kind,
        context,
        timestamp: Date.now(),
        payload: buildPayload(kind, e),
      };
      dev.log("tap", kind, `${kind} event`, capture);
      sink(capture);
    };

    const onClick = handle("click");
    const onKeydown = handle("keydown");
    const onScroll = handle("scroll");

    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("scroll", onScroll);
    };
  };
}

function buildPayload(
  kind: string,
  e: Event,
): Record<string, unknown> {
  if (kind === "click" && e.target instanceof Element) {
    return {
      tag: e.target.tagName.toLowerCase(),
      text: (e.target as HTMLElement).innerText?.slice(0, 120) ?? "",
      selector: cssSelector(e.target),
    };
  }
  if (kind === "keydown" && e instanceof KeyboardEvent) {
    return { key: e.key };
  }
  if (kind === "scroll") {
    return { scrollY: window.scrollY };
  }
  return {};
}

function cssSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const cls = el.className
    ? `.${el.className.trim().split(/\s+/).join(".")}`
    : "";
  return `${tag}${cls}`;
}
