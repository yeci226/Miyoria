import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, expect } from "vitest";

// Registered on this package's own Vitest: `@testing-library/jest-dom/vitest` would import
// whichever `vitest` pnpm hoists in the workspace, which is not the one running these tests.
expect.extend(matchers);

// A page is loaded lazily, so the first `findBy…` of a file also waits for its module. The
// default second is not always enough on a slow CI runner; a query that finds its element
// returns at once either way.
configure({ asyncUtilTimeout: 4000 });

// jsdom does not implement scrolling; the router's scroll restoration calls it.
window.scrollTo = (() => {}) as typeof window.scrollTo;

// What Radix (Select, DropdownMenu, Popover, Tooltip) and cmdk need from a browser.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
// The landing reveals its sections as they scroll into view: jsdom has no IntersectionObserver.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver ??= IntersectionObserverStub as unknown as typeof IntersectionObserver;
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.setPointerCapture ??= () => {};
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
