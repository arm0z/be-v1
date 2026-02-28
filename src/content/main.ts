import { registry } from "../event/registry.ts";
import { needsSpaObserver, observeSpaNavigation } from "../event/spa-observer.ts";

function bootstrap(): void {
  const url = window.location.href;
  const route = registry.find((r) => r.match(url));
  if (!route) return;

  let teardown = route.build();
  let currentRoute = route;

  if (needsSpaObserver(url)) {
    observeSpaNavigation((newUrl) => {
      const next = registry.find((r) => r.match(newUrl));
      if (next && next !== currentRoute) {
        teardown();
        currentRoute = next;
        teardown = next.build();
      }
    });
  }
}

bootstrap();
