// The front page by profile: the first character keeps her own page, chosen without a request;
// another profile gets its own content or the plain page, its words drawn as text.

import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingFirst } from "@/app/LandingFirst";
import { WORLD } from "@/lib/world";
import { frontPageFor } from "./front";
import { LandingPage, PLAIN, plainLine, readLanding } from "./ProfileLanding";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("the first character's front page", () => {
  it("is chosen without the Core's tag, is today's page and asks for no landing content", async () => {
    expect(WORLD.landing).toBe("builtin");
    expect((await frontPageFor("builtin")()).default).toBe((await import("./Landing")).default);
    expect((await frontPageFor("plain")()).default).toBe((await import("./ProfileLanding")).default);
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://panel.test").pathname;
        asked.push(path);
        if (path === "/api/auth/methods") return json({ token: true, discord: false });
        if (path === "/api/public/status") return json({ state: "idle", live: false, in_voice: false, game: null, today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 } });
        if (path === "/api/public/songs") return json({ playing: null, upcoming: [], recent: [] });
        return json({ error: "missing or invalid bearer token" }, 401);
      }),
    );
    render(<LandingFirst onHandOff={() => {}} />);
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Miyoria");
    expect(h1).toHaveTextContent("住在 Discord");
    expect(screen.getByText(/一隻穿女僕裝的鯨魚/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "她平常在群組裡" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "想在自己的群組養一隻？" })).toBeInTheDocument();
    expect(screen.getByText("立繪：神宫凉子・黑洞 shader：glsl-black-hole（MIT）")).toBeInTheDocument();
    await waitFor(() => expect(asked).toContain("/api/public/status"));
    expect(asked).not.toContain("/api/public/landing");
  });
});

describe("another profile's front page", () => {
  it("reads the Core's answer, keeping only text and the Core's own picture paths", () => {
    expect(readLanding(null)).toEqual(PLAIN);
    expect(readLanding({ kind: "plain", name: "Kuro", line: "Kuro 在這裡。" })).toEqual({ name: "Kuro", line: "Kuro 在這裡。", cover: null, sections: [] });
    expect(readLanding({ kind: "plain", name: "Kuro" }).line).toBe(plainLine("Kuro"));
    const own = readLanding({
      kind: "own",
      name: "Kuro",
      line: "黑貓。",
      cover: "/api/public/landing/files/cover.webp",
      sections: [
        { title: "日常", text: "睡覺", image: "/api/public/landing/files/a.webp" },
        { title: "外面的圖", text: "x", image: "https://evil.example/a.png" },
        { title: "往上", text: "x", image: "/api/public/landing/files/../../secret" },
        { title: 3, text: null },
        "nope",
      ],
    });
    expect(own.cover).toBe("/api/public/landing/files/cover.webp");
    expect(own.sections).toEqual([
      { title: "日常", text: "睡覺", image: "/api/public/landing/files/a.webp" },
      { title: "外面的圖", text: "x", image: null },
      { title: "往上", text: "x", image: null },
    ]);
  });

  it("draws the plain page: her name, one line, the live room, login when there is one, the panel", () => {
    render(<LandingPage content={{ ...PLAIN, name: "Kuro", line: plainLine("Kuro") }} loginUrl="/api/auth/oauth/login?next=%2F" notice="登入失敗" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Kuro");
    expect(screen.getByText("Kuro 是住在 Discord 和直播裡的 AI VTuber。")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("登入失敗");
    expect(screen.getAllByRole("link", { name: /Discord 登入/ })[0]).toHaveAttribute("href", "/api/auth/oauth/login?next=%2F");
    expect(screen.getAllByRole("link", { name: "直播間" })[0]).toHaveAttribute("href", "/watch");
    expect(screen.getByRole("link", { name: "管理面板" })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws its own sections and pictures, and never reads its words as HTML", () => {
    const { container } = render(
      <LandingPage
        content={{
          name: "Kuro",
          line: "<b>黑貓</b>",
          cover: "/api/public/landing/files/cover.webp",
          sections: [
            { title: "日常", text: "<img src=x onerror=alert(1)>睡覺", image: "/api/public/landing/files/a.webp" },
            { title: "唱歌", text: "會唱歌", image: null },
          ],
        }}
        loginUrl={null}
      />,
    );
    expect(screen.getByText("<b>黑貓</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
    const daily = screen.getByRole("region", { name: "日常" });
    expect(within(daily).getByText("<img src=x onerror=alert(1)>睡覺")).toBeInTheDocument();
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
      "/api/public/landing/files/cover.webp",
      "/api/public/landing/files/a.webp",
    ]);
    expect(screen.getByRole("region", { name: "唱歌" })).toHaveTextContent("會唱歌");
    expect(screen.queryByRole("link", { name: /Discord 登入/ })).toBeNull();
  });
});
