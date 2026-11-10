import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEvent } from "@/api/types";
import { mockFetch, renderPage } from "@/test/render";
import { ConsciousnessBlock } from "./consciousness";

const NOW = Date.now();
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
const CTX = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" } as const;

function ev(id: string, secAgo: number, kind: LogEvent["kind"], source: string, body: unknown, cause: string | null = null): LogEvent {
  return { id, at: at(secAgo), kind, source, cause, context: CTX, person: null, body };
}

const spoken = (summary: string, key: string) => ({
  observation: { source: "voice.asr", silent: false, salience: "notable", attention_key: key, revision: 1, summary, addressed_to_her: true, from: "owen", context: CTX },
  speech: true,
});

const HEARD = ev("E1", 50, "observation", "voice.asr", spoken("Owen:不要再玩 Minecraft", "voice:u1"));
const THOUGHT = ev("E2", 46, "decision", "agent", { turn: "T1", respond: true, reasons: ["被叫到"] }, "E1");
const ACTION = ev("E3", 44, "action", "gate", { capability: "game.stop", allowed: true, turn: "T1", why: "主人要求" }, "E2");
const STEER = ev("E4", 43, "steer", "game.minecraft", { phase: "outcome", task: "K1", steer: "S1", outcome: "applied", detail: "改成先收遊戲" }, "E3");
const SAID = ev("E5", 40, "utterance", "delivery.voice", { said: "好啦,麥塊收掉了", channel: "voice", turn: "T1" }, "E2");
const OTHER = ev("E6", 20, "observation", "voice.asr", spoken("Owen:你去唱歌啊", "voice:u2"));
const AMBIENT = ev("E7", 30, "observation", "system", {
  observation: { source: "system", silent: true, salience: "ambient", attention_key: "system:module:x", revision: 1, summary: "模組 x:running", addressed_to_her: false, from: null, context: null },
  speech: false,
});

// Newest first, as the API answers.
const WINDOW = [OTHER, AMBIENT, SAID, STEER, ACTION, THOUGHT, HEARD];

const AXIS = { name: "聽到、想、說、做的時間線" };

function serve(events: LogEvent[] = WINDOW) {
  return mockFetch((_m, url) => {
    if (url.pathname === "/api/facts/events") return { body: events };
    if (url.pathname === "/api/facts/events/E3/chain") return { body: { events: [HEARD, THOUGHT, ACTION], complete: true } };
    if (url.pathname === "/api/facts/events/E3/effects") return { body: [STEER] };
    return undefined;
  });
}

beforeEach(() => window.localStorage.clear());

const point = (name: RegExp) => screen.getByRole("button", { name });

describe("意識軸", () => {
  it("draws the four lanes with what she heard, thought, said and did", async () => {
    serve();
    renderPage(<ConsciousnessBlock />);
    const group = await screen.findByRole("group", AXIS);
    for (const lane of ["聽到", "想", "說", "做"]) expect(within(group).getAllByText(lane).length).toBeGreaterThan(0);
    expect(point(/聽到 .*不要再玩 Minecraft/)).toBeInTheDocument();
    expect(point(/想 .*回應/)).toBeInTheDocument();
    expect(point(/說 .*好啦/)).toBeInTheDocument();
    expect(point(/做 .*game\.stop/)).toBeInTheDocument();
  });

  it("leaves ambient observations off and says how many", async () => {
    serve();
    renderPage(<ConsciousnessBlock />);
    await screen.findByRole("group", AXIS);
    expect(screen.queryByRole("button", { name: /模組 x/ })).not.toBeInTheDocument();
    expect(screen.getByText("1 筆背景觀察沒有畫出")).toBeInTheDocument();
  });

  it("selecting a point highlights its chain and lists the steps, steer included", async () => {
    const fetch = serve();
    const user = userEvent.setup();
    renderPage(<ConsciousnessBlock />);
    await screen.findByRole("group", AXIS);

    await user.click(point(/做 .*game\.stop/));

    const steps = await screen.findByRole("list", { name: "這條因果鏈" });
    const items = within(steps).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(items[0] as HTMLElement).getByText("Owen:不要再玩 Minecraft")).toBeInTheDocument();
    expect(within(items[3] as HTMLElement).getByText("改方向")).toBeInTheDocument();
    expect(within(items[3] as HTMLElement).getByText("改成先收遊戲")).toBeInTheDocument();
    expect(within(items[3] as HTMLElement).getByText("已套用")).toBeInTheDocument();

    const on = (name: RegExp) => point(name).getAttribute("data-chain");
    expect(on(/聽到 .*不要再玩/)).toBe("on");
    expect(on(/想 .*回應/)).toBe("on");
    expect(on(/做 .*game\.stop/)).toBe("on");
    expect(on(/做 .*改成先收遊戲/)).toBe("on");
    expect(on(/聽到 .*你去唱歌/)).toBeNull();
    // E5 hangs off E2, a cause of E3: a sibling, neither a cause nor an effect of it.
    expect(on(/說 .*好啦/)).toBeNull();

    const paths = fetch.mock.calls.map(([u]) => new URL(String(u), "http://x").pathname);
    expect(paths).toContain("/api/facts/events/E3/chain");
    expect(paths).toContain("/api/facts/events/E3/effects");
  });

  it("walks the points with the arrow keys and selects with Enter", async () => {
    serve();
    renderPage(<ConsciousnessBlock />);
    await screen.findByRole("group", AXIS);

    // One tab stop for the whole axis.
    const points = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-id"));
    expect(points.filter((b) => b.getAttribute("tabindex") === "0")).toHaveLength(1);

    const first = point(/聽到 .*不要再玩/);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(point(/想 .*回應/)).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^說 /);
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(point(/做 .*改成先收遊戲/)).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(point(/做 .*game\.stop/)).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(await screen.findByRole("list", { name: "這條因果鏈" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("list", { name: "這條因果鏈" })).not.toBeInTheDocument());
  });

  it("asks for the chosen range", async () => {
    const fetch = serve();
    const user = userEvent.setup();
    renderPage(<ConsciousnessBlock />);
    await screen.findByRole("group", AXIS);
    await user.click(screen.getByRole("radio", { name: "1 分" }));
    await waitFor(() => {
      const ages = fetch.mock.calls
        .map(([u]) => new URL(String(u), "http://x").searchParams.get("since"))
        .filter((s): s is string => s !== null)
        .map((s) => Date.now() - Date.parse(s));
      expect(ages.some((age) => age > 55_000 && age < 70_000)).toBe(true);
    });
    expect(screen.getByRole("radio", { name: "1 分" })).toBeChecked();
  });

  it("says plainly when there is nothing to draw", async () => {
    serve([]);
    renderPage(<ConsciousnessBlock />);
    expect(await screen.findByText("這段時間沒有事件")).toBeInTheDocument();
    expect(screen.queryByRole("group", AXIS)).not.toBeInTheDocument();
  });

  it("counts background observations when only those happened", async () => {
    serve([AMBIENT]);
    renderPage(<ConsciousnessBlock />);
    expect(await screen.findByText("這段時間沒有對話或動作,只有 1 筆背景觀察")).toBeInTheDocument();
  });

  it("shows a skeleton while loading, not a made-up axis", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container } = renderPage(<ConsciousnessBlock />);
    await waitFor(() => expect(container.querySelector("[data-slot=skeleton]")).not.toBeNull());
    expect(screen.queryByRole("group", AXIS)).not.toBeInTheDocument();
  });

  it("says an older Core has no event log", async () => {
    mockFetch(() => ({ status: 404, body: { error: "no such endpoint" } }));
    renderPage(<ConsciousnessBlock />);
    expect(await screen.findByText("這個 Core 還沒有事件紀錄")).toBeInTheDocument();
  });

  it("shows a failure with a retry", async () => {
    let fail = true;
    mockFetch((_m, url) => {
      if (url.pathname !== "/api/facts/events") return undefined;
      return fail ? { status: 500, body: { error: "log is down" } } : { body: [HEARD] };
    });
    const user = userEvent.setup();
    renderPage(<ConsciousnessBlock />);
    expect(await screen.findByRole("alert")).toHaveTextContent("log is down");
    fail = false;
    await user.click(screen.getByRole("button", { name: /重試/ }));
    expect(await screen.findByRole("group", AXIS)).toBeInTheDocument();
  });

  it("says when the earlier causes are gone", async () => {
    mockFetch((_m, url) => {
      if (url.pathname === "/api/facts/events") return { body: [ACTION] };
      if (url.pathname === "/api/facts/events/E3/chain") return { body: { events: [ACTION], complete: false } };
      if (url.pathname === "/api/facts/events/E3/effects") return { body: [] };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<ConsciousnessBlock />);
    await user.click(await screen.findByRole("button", { name: /做 .*game\.stop/ }));
    expect(await screen.findByText("更早的起因已經不在紀錄裡")).toBeInTheDocument();
  });

  it("opens one step in full", async () => {
    serve();
    const user = userEvent.setup();
    renderPage(<ConsciousnessBlock />);
    await user.click(await screen.findByRole("button", { name: /做 .*game\.stop/ }));
    const steps = await screen.findByRole("list", { name: "這條因果鏈" });
    await user.click(within(within(steps).getAllByRole("listitem")[2] as HTMLElement).getByRole("button", { name: "詳情" }));
    expect(await screen.findByLabelText("事件")).toHaveTextContent('"capability": "game.stop"');
  });
});
