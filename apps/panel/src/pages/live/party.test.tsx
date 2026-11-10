import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PartySnapshot } from "@/api/v4-types";
import { endReason, scoreLine } from "@/lib/party";
import { mockFetch, renderRoute } from "@/test/render";

const VOICE = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" } as const;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const player = (name: string, score: number, her = false) => ({ name, her, score, present: true, active: score > 0 });

const SNAPSHOT: PartySnapshot = {
  sessions: [
    { id: "S2", game: "soup", title: "海龜湯", context: VOICE, state: "running", started_at: ago(300_000), scored: false, players: [player("你", 0, true), player("Owen", 0)] },
  ],
  recent: [
    { id: "S1", game: "quiz", title: "問答", context: VOICE, reason: "done", started_at: ago(4_000_000), ended_at: ago(3_600_000), scored: true, players: [player("Owen", 30), player("你", 10, true), player("Amy", 0)] },
  ],
};

describe("派對遊戲 (from /api/party)", () => {
  it("words the end and the standings", () => {
    expect(endReason("stop")).toBe("有人說不玩了");
    expect(endReason("weird")).toBe("weird");
    expect(scoreLine(SNAPSHOT.recent[0]?.players ?? [])).toBe("Owen 30、你 10");
  });

  it("shows the running game per voice channel and the recent results on 直播", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/party" ? { body: SNAPSHOT } : undefined));
    renderRoute("/live");
    const card = await screen.findByRole("region", { name: "派對遊戲" });
    const running = await within(card).findByRole("list", { name: "進行中的遊戲" });
    expect(within(running).getByText("海龜湯")).toBeInTheDocument();
    expect(running).toHaveTextContent("1 人在場");
    const results = within(card).getByRole("region", { name: "最近的結果" });
    expect(results).toHaveTextContent("最後分數:Owen 30、你 10");
    expect(results).toHaveTextContent("玩完了");
  });

  it("has empty, module-off and error states", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/party" ? { body: { sessions: [], recent: [] } } : undefined));
    const a = renderRoute("/live");
    expect(await screen.findByText("現在沒有人在玩")).toBeInTheDocument();
    a.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/party" ? { status: 503, body: { error: "party module is not running" } } : undefined));
    const b = renderRoute("/live");
    expect(await screen.findByText("派對遊戲(party 模組)沒有啟動")).toBeInTheDocument();
    b.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/party" ? { status: 500, body: { error: "boom" } } : undefined));
    renderRoute("/live");
    const card = await screen.findByRole("region", { name: "派對遊戲" });
    expect(await within(card).findByRole("alert")).toHaveTextContent("boom");
  });
});
