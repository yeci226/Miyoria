// A card's picture on the pages: the Core's (her rendered one, or the fixed portrait it picks),
// and the fixed portrait file from the panel's own folder for a card the Core will not show.

import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssuedCard } from "@miyoria/contracts/api";
import { testQueryClient } from "@/test/render";
import { artUrl, poseUrl, useCardArt } from "./card";

/** `fetch` answering the pictures in `known` (path to type) and 404 for the rest; the page's own Blob, so it can be read. */
function pictures(known: Record<string, string>) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const type = known[new URL(String(input), "http://panel.test").pathname];
    if (type === undefined) return { ok: false, status: 404, blob: async () => new Blob([]) };
    return { ok: true, status: 200, blob: async () => new Blob(["x"], { type }) };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const CARD = {
  serial: "MYR-ABCD-0000-0001",
  pose: "smile",
  parts: [],
  expression: null,
} as unknown as IssuedCard;

const wrapper = () => {
  const client = testQueryClient();
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

afterEach(() => vi.unstubAllGlobals());

describe("a card's picture", () => {
  it("comes from the Core, whatever it is, and is the mask of the foil too", async () => {
    const fn = pictures({ [artUrl(CARD.serial)]: "image/png", [poseUrl("smile")]: "image/webp" });
    const { result } = renderHook(() => useCardArt(CARD), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toMatch(/^data:image\/png/));
    expect(result.current.url).toBe(artUrl(CARD.serial));
    expect(artUrl(CARD.serial)).toBe("/api/public/card-art/MYR-ABCD-0000-0001.png");
    // The fixed portrait is not asked for while the Core has one.
    const asked = fn.mock.calls.map(([input]) => new URL(String(input), "http://panel.test").pathname);
    expect(asked).toEqual([artUrl(CARD.serial)]);
  });

  it("falls back to the fixed portrait of the card's pose when the Core will not show it", async () => {
    pictures({ [poseUrl("smile")]: "image/webp" });
    const { result } = renderHook(() => useCardArt(CARD), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toMatch(/^data:image\/webp/));
    expect(result.current.url).toBe(poseUrl("smile"));
  });

  it("has none, without error, when neither has a picture", async () => {
    const fn = pictures({});
    const { result } = renderHook(() => useCardArt(CARD), { wrapper: wrapper() });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(result.current).toEqual({ url: null, data: null });
  });
});
