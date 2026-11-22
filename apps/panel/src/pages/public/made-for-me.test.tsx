import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MemberFile, MemberFiles } from "@miyoria/contracts/api";
import { mockFetch, renderPage } from "@/test/render";
import { MadeForMe } from "./MadeForMe";

const item = (over: Partial<MemberFile> = {}): MemberFile => ({
  id: "01JZ0000000000000000000001",
  filename: "cat.png",
  kind: "image",
  mime: "image/png",
  size: 2048,
  source: "imagegen",
  made_at: "2026-11-22T00:00:00.000Z",
  expires_at: "2026-11-29T00:00:00.000Z",
  kept: false,
  made_in: "dm",
  visibility: "none",
  link_expires_at: null,
  listen_only: false,
  allowed: ["none", "person", "link"],
  ...over,
});

const list = (items: MemberFile[], available = true): MemberFiles => ({
  links: { available, scoped: available },
  quota: { used: 1, per_day: 20 },
  items,
});

describe("她做給我的", () => {
  it("lists her things and never offers a server for something made in a DM", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/member/files" ? { body: list([item()]) } : undefined));
    renderPage(<MadeForMe />);
    expect(await screen.findByText("cat.png")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "伺服器成員" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "只有我" })).toBeEnabled();
    expect(screen.getByText(/今天做了 1 \/ 20 條連結/)).toBeInTheDocument();
  });

  it("makes a new link and shows it once", async () => {
    const user = userEvent.setup();
    const posted: string[] = [];
    const url = "https://files.example.test/f/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    mockFetch((method, u, body) => {
      if (method === "GET" && u.pathname === "/api/member/files") return { body: list([item()]) };
      if (method === "POST" && u.pathname.endsWith("/visibility")) {
        posted.push(JSON.stringify(body));
        return { body: { item: item({ visibility: "person" }), url } };
      }
      return undefined;
    });
    renderPage(<MadeForMe />);
    await user.click(await screen.findByRole("radio", { name: "只有我" }));
    await waitFor(() => expect(posted).toEqual(['{"visibility":"person"}']));
    expect(await screen.findByText(url)).toBeInTheDocument();
  });

  it("says there is no file domain yet, and a song cover is only heard", async () => {
    mockFetch((_m, url) =>
      url.pathname === "/api/member/files"
        ? { body: list([item({ source: "sing", listen_only: true, allowed: ["none"], filename: "song.mp3" })], false) }
        : undefined,
    );
    renderPage(<MadeForMe />);
    expect(await screen.findByText(/還沒有設定檔案網域/)).toBeInTheDocument();
    expect(screen.getByText(/只在語音和直播裡聽/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /下載/ })).toBeNull();
  });
});
