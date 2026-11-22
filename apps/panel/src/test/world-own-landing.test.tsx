// A profile with its own front page (`landing.json` in its folder): the page asks the Core for it
// and draws its sections, and falls back to the plain page while it cannot.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const world = { currency: "貝殼", exchange_name: "珊瑚交易所", pronoun: "他", persona: "Kuro", landing: "own" };
  document.head.insertAdjacentHTML(
    "beforeend",
    `<meta property="og:site_name" content="Kuro" /><meta name="miyoria:world" content="${JSON.stringify(world).replace(/"/g, "&quot;")}" />`,
  );
});

import { LandingFirst } from "@/app/LandingFirst";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function core(landing: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://panel.test").pathname;
      if (path === "/api/auth/methods") return json({ token: true, discord: true });
      if (path === "/api/public/landing") return landing();
      if (path === "/api/public/status") return json({ state: "idle", live: false, in_voice: false, game: null, today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 } });
      return json({ error: "missing or invalid bearer token" }, 401);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("a profile's own front page", () => {
  it("draws the content the Core serves, with its pictures", async () => {
    core(() =>
      json({
        kind: "own",
        name: "Kuro",
        line: "一隻黑貓。",
        cover: "/api/public/landing/files/cover.webp",
        sections: [{ title: "他平常在群組裡", text: "<i>直接標他</i>", image: "/api/public/landing/files/chat.webp" }],
      }),
    );
    const { container } = render(<LandingFirst onHandOff={() => {}} />);
    expect(await screen.findByText("一隻黑貓。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Kuro");
    expect(screen.getByRole("heading", { name: "他平常在群組裡" })).toBeInTheDocument();
    expect(screen.getByText("<i>直接標他</i>")).toBeInTheDocument();
    expect(container.querySelector("i")).toBeNull();
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
      "/api/public/landing/files/cover.webp",
      "/api/public/landing/files/chat.webp",
    ]);
    // Discord login is on: once the check answers, the button shows.
    await waitFor(() => expect(screen.getAllByRole("link", { name: /Discord 登入/ }).length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toMatch(/Miyoria|鯨魚|魚幣/);
  });

  it("is the plain page when the content cannot be read", async () => {
    core(() => json({ error: "not found" }, 404));
    render(<LandingFirst onHandOff={() => {}} />);
    expect(await screen.findByText("Kuro 是住在 Discord 和直播裡的 AI VTuber。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Kuro");
  });
});
