import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@/api/types";
import { readStorage, writeStorage } from "@/lib/storage";
import { STORAGE_TOKEN } from "./connection";
import { LandingFirst } from "./LandingFirst";
import { landingFirst, rememberVisitor, SIGNED_IN_HINT, type Visitor } from "./visitor";

const admin: SessionInfo = { method: "discord", user: { id: "1", name: "Owen", avatar_url: null }, permissions: { write: true } };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Core whose `/api/auth/session` answers only when `answer` is called. */
function slowCore(publicSite = true) {
  let answer: (res: Response) => void = () => {};
  const session = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://panel.test").pathname;
      if (path === "/api/auth/methods") return json({ token: true, discord: true });
      if (path === "/api/auth/session") return session;
      if (path === "/api/public/status" && publicSite) {
        return json({ state: "idle", live: false, in_voice: false, game: null, today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 } });
      }
      if (path === "/api/public/songs") return json({ playing: null, upcoming: [], recent: [] });
      return json({ error: "missing or invalid bearer token" }, 401);
    }),
  );
  return { answer: (res: Response) => answer(res) };
}

afterEach(() => {
  writeStorage(STORAGE_TOKEN, null);
  writeStorage(SIGNED_IN_HINT, null);
  vi.unstubAllGlobals();
});

describe("landing first", () => {
  it("shows the landing only to a first visit of the front page", () => {
    expect(landingFirst("/", "")).toBe(true);
    expect(landingFirst("/watch", "")).toBe(false);
    expect(landingFirst("/card/MYR-AB12-CD34-EF56", "")).toBe(false);
    expect(landingFirst("/login", "")).toBe(false);
    expect(landingFirst("/", "saved-token")).toBe(false);
    writeStorage(SIGNED_IN_HINT, "1");
    expect(landingFirst("/", "")).toBe(false);
  });

  it("remembers whether someone was logged in", () => {
    rememberVisitor({ status: "checking" });
    expect(readStorage(SIGNED_IN_HINT)).toBeNull();
    rememberVisitor({ status: "signed_in", session: admin });
    expect(readStorage(SIGNED_IN_HINT)).toBe("1");
    rememberVisitor({ status: "public", member: null });
    expect(readStorage(SIGNED_IN_HINT)).toBeNull();
    rememberVisitor({ status: "public", member: { name: "Amy", avatar_url: null } });
    expect(readStorage(SIGNED_IN_HINT)).toBe("1");
    rememberVisitor({ status: "signed_out" });
    expect(readStorage(SIGNED_IN_HINT)).toBeNull();
  });

  it("shows her before the login check answers, and keeps her for someone not logged in", async () => {
    const core = slowCore();
    const handOff = vi.fn();
    render(<LandingFirst onHandOff={handOff} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("住在 Discord");
    expect(screen.queryByRole("link", { name: /Discord 登入/ })).toBeNull();
    core.answer(json({ error: "missing or invalid bearer token" }, 401));
    // Once the Core says Discord login is on, the button shows; the page stays hers.
    await waitFor(() => expect(screen.getAllByRole("link", { name: /Discord 登入/ }).length).toBeGreaterThan(0));
    expect(handOff).not.toHaveBeenCalled();
  });

  it("hands the page to the panel when someone turns out to be logged in", async () => {
    const core = slowCore();
    const handOff = vi.fn<(visitor: Visitor) => void>();
    render(<LandingFirst onHandOff={handOff} />);
    await screen.findByRole("heading", { level: 1 });
    core.answer(json(admin));
    await waitFor(() => expect(handOff).toHaveBeenCalledTimes(1));
    expect(handOff.mock.calls[0]?.[0]).toEqual({ auth: { status: "signed_in", session: admin }, methods: { token: true, discord: true } });
  });
});
