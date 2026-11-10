import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DirectorThoughtBody, LogEvent } from "@/api/types";
import { describe as describeEvent } from "@/lib/consciousness";
import { DirectorTrace, wantText } from "./director-trace";

const body: DirectorThoughtBody = {
  game: "minecraft",
  trigger: ["血量變低", "天黑了"],
  goal: "弄到食物",
  action: "obtain cooked_beef",
  verdict: "start",
  commentary: "好餓喔",
  busy: false,
  observation: "血 8/20,飢餓 3,背包:木鎬、生牛肉×2;附近有牛",
  want: { item: "cooked_beef", count: 3 },
  held: ["obtain bread 失敗兩次(沒有食譜),先換方法", "goto 家 被擋"],
};

describe("導演的決定", () => {
  it("shows what she saw, what she wanted and which methods were held", () => {
    render(<DirectorTrace body={body} />);
    const dl = screen.getByLabelText("導演的決定");
    expect(dl).toHaveTextContent("血量變低;天黑了");
    expect(within(dl).getByText(/血 8\/20/)).toBeInTheDocument();
    expect(dl).toHaveTextContent("背包裡要有 cooked_beef×3");
    const held = within(dl).getByText("被擋住的方法").closest("div") as HTMLElement;
    expect(within(held).getAllByRole("listitem")).toHaveLength(2);
    expect(dl).toHaveTextContent("obtain cooked_beef");
  });

  it("says nothing was held, and leaves out what an older Core does not write", () => {
    const { rerender } = render(<DirectorTrace body={{ ...body, held: [] }} />);
    expect(screen.getByText("沒有")).toBeInTheDocument();
    const { observation: _o, want: _w, held: _h, ...old } = body;
    rerender(<DirectorTrace body={old} />);
    expect(screen.queryByText("被擋住的方法")).not.toBeInTheDocument();
    expect(screen.queryByText("她看到的")).not.toBeInTheDocument();
    expect(screen.queryByText("成功條件")).not.toBeInTheDocument();
  });

  it("names the want in the event line", () => {
    expect(wantText({ item: "bread", count: 1 })).toBe("bread");
    const event: LogEvent = { id: "e", at: "2026-11-10T10:00:00.000Z", kind: "thought", source: "game.director", cause: null, context: null, person: null, body };
    expect(describeEvent(event).detail).toBe("game.director · 要 cooked_beef×3 · 2 個方法被擋");
    const old: LogEvent = { ...event, body: { game: "minecraft", trigger: [], goal: "蓋房子", action: null, verdict: null, commentary: null, busy: null } };
    expect(describeEvent(old).detail).toBe("game.director");
  });
});
