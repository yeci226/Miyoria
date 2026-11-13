import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Her } from "./Landing";

const loop = { src: "/assets/heart.webm", poster: "/assets/heart.webp" };

/** An IntersectionObserver the test moves things in and out of view with. */
function observers() {
  const all: Array<{ cb: IntersectionObserverCallback; margin?: string; targets: Element[] }> = [];
  class Fake {
    targets: Element[] = [];
    constructor(
      readonly cb: IntersectionObserverCallback,
      readonly options?: IntersectionObserverInit,
    ) {
      all.push({ cb, margin: options?.rootMargin, targets: this.targets });
    }
    observe(el: Element) {
      this.targets.push(el);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", Fake);
  const see = (el: Element, isIntersecting: boolean) =>
    act(() => {
      for (const o of all.filter((x) => x.targets.includes(el))) {
        o.cb([{ isIntersecting, target: el } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    });
  return { all, see };
}

function reducedMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("her loops", () => {
  it("download nothing until near the screen, then play only while seen", async () => {
    reducedMotion(false);
    const io = observers();
    const { container } = render(<Her loop={loop} />);
    const v = container.querySelector("video") as HTMLVideoElement;
    expect(v.getAttribute("src")).toBeNull();
    expect(v.getAttribute("poster")).toBeNull();
    expect(v.preload).toBe("none");
    expect(io.all[0]?.margin).toBe("50% 0px");

    await io.see(v, true);
    expect(v.getAttribute("src")).toBe(loop.src);
    expect(v.getAttribute("poster")).toBe(loop.poster);
    expect(v.preload).toBe("auto");
    expect(v.autoplay).toBe(true);

    const pause = vi.spyOn(v, "pause").mockImplementation(() => {});
    const play = vi.spyOn(v, "play").mockResolvedValue(undefined);
    vi.spyOn(v, "currentSrc", "get").mockReturnValue(`http://panel.test${loop.src}`);
    await io.see(v, false);
    expect(pause).toHaveBeenCalledTimes(1);
    await io.see(v, true);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("the cover loads at once", () => {
    reducedMotion(false);
    observers();
    const { container } = render(<Her loop={loop} eager />);
    const v = container.querySelector("video") as HTMLVideoElement;
    expect(v.getAttribute("src")).toBe(loop.src);
    expect(v.preload).toBe("auto");
  });

  it("with reduced motion shows the still and never plays", async () => {
    reducedMotion(true);
    const io = observers();
    const { container } = render(<Her loop={loop} />);
    const v = container.querySelector("video") as HTMLVideoElement;
    const play = vi.spyOn(v, "play").mockResolvedValue(undefined);
    await io.see(v, true);
    expect(v.getAttribute("poster")).toBe(loop.poster);
    expect(v.autoplay).toBe(false);
    expect(v.preload).toBe("none");
    await io.see(v, false);
    await io.see(v, true);
    expect(play).not.toHaveBeenCalled();
  });
});
