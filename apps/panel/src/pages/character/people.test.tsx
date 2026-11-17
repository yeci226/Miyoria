import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { HeartHistoryEntry, PersonProfile, PersonRow } from "@miyoria/contracts/api";
import { mockFetch, renderPage, renderRoute } from "@/test/render";
import { anchorTiers, fmtDelta, fmtValue, levels } from "./heart";
import { parseValue } from "./PersonHeart";
import { PersonSheet } from "./PersonSheet";

const AT = "2026-11-10T12:00:00.000Z";

const row = (id: string, name: string, over: Partial<PersonRow> = {}): PersonRow => ({
  person: {
    id,
    display_name: name,
    created_at: "2026-01-01T00:00:00Z",
    accounts: [{ account: { platform: "discord", id: `${id}-d` }, display_name: name, first_seen: "2026-01-01T00:00:00Z", last_seen: AT }],
  },
  has_row: true,
  blocked: false,
  owner: false,
  tier: "心有靈犀",
  stage: 2,
  tier_label: "心有靈犀 II",
  bond: 342,
  ring: { lap: 3, fraction: 0.42, full: false, below: 0 },
  trust: 62,
  familiarity: 48,
  warmth: 0.35,
  respect: -0.1,
  ease: 0.7,
  grudge: 0.15,
  longing: 0.4,
  rapport: 0.55,
  cares: 0.71,
  stance: "會鬧他,但他認真的時候不鬧",
  impression: "記性很好,答應的事會做",
  public_feeling: "我還沒說你就知道了",
  call_name: "小明",
  tags: ["常客"],
  interactions: 40,
  last_interaction: AT,
  last_seen: AT,
  last_together: AT,
  updated_at: AT,
  ...over,
});

const change = (id: string, field: HeartHistoryEntry["field"], delta: number, value_after: number, quote: string, at = AT): HeartHistoryEntry => ({
  id,
  at,
  field,
  delta,
  value_after,
  proposed: delta,
  cause: "feel",
  reason_quote: quote,
});

const profile = (over: Partial<PersonProfile> = {}): PersonProfile => ({
  ...row("P1", "Ming"),
  next_tier: "形影不離",
  next_label: "心有靈犀 III",
  tier_progress: 0.6,
  tier_floor: 300,
  held: null,
  anchors: [{ tier: 300, tier_name: "心有靈犀", note_ref: "n1", quote: "那天他陪我把整首歌練完", at: "2026-11-02T12:00:00.000Z", by: "reflect" }],
  unfinished: "他換工作的事",
  jokes: "香菜",
  dislikes: "",
  history: {
    items: [change("E3", "rapport", 0.04, 0.55, "他接了我上次那個梗"), change("E2", "bond", 1.5, 342, "記得我說想吃的東西", "2026-11-10T11:00:00.000Z")],
    next_before: "E2",
  },
  ledger: [
    { field: "bond", used_up: 3.5, used_down: 0, cap_up: 6, cap_down: 18, proposed_up: 2, proposed_down: 0 },
    { field: "trust", used_up: 0, used_down: 0, cap_up: 2, cap_down: 6, proposed_up: 0, proposed_down: 0 },
  ],
  evidence: [{ id: "V1", at: AT, kind: "voice_together", detail: "在你的語音頻道一起待了 42 分鐘", weight: 42 }],
  memory_count: 3,
  ...over,
});

const readOnly = { session: { method: "token" as const, user: null, permissions: { write: false } }, logout: () => {} };

describe("people list", () => {
  it("draws the small ring and the bond beside it, and the tier with its stage", async () => {
    mockFetch((_m, url) => {
      if (url.pathname === "/api/people") {
        return {
          body: {
            items: [
              row("P1", "Ming"),
              row("P2", "Kuro", { has_row: false, tier: "陌生人", stage: null, tier_label: "陌生人", bond: 0, ring: { lap: 0, fraction: 0, full: false, below: 0 } }),
            ],
            next_cursor: null,
          },
        };
      }
      if (url.pathname.endsWith("/history")) return { body: { items: [], next_before: null } };
      return undefined;
    });
    renderRoute("/character?tab=people");
    const table = await screen.findByRole("table", { name: "人" });
    const ming = within(table).getByText("Ming").closest("tr") as HTMLElement;
    expect(within(ming).getByText("心有靈犀 II")).toBeInTheDocument();
    expect(within(ming).getByText("342")).toBeInTheDocument();
    const mark = ming.querySelector('[data-bond-ring="mark"]');
    expect(mark).not.toBeNull();
    // The mark is the small one: no segments, nothing written on the heart.
    expect(mark?.querySelectorAll("[data-segment]")).toHaveLength(0);
    expect(mark?.querySelector("text")).toBeNull();

    const kuro = within(table).getByText("Kuro").closest("tr") as HTMLElement;
    expect(within(kuro).getByText("陌生人")).toBeInTheDocument();
    expect(kuro.querySelector("[data-bond-ring]")).toBeNull();
  });
});

describe("person sheet", () => {
  it("shows the ring with the bond, where the tier stands and the eight values", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/people/P1" ? { body: profile({ held: { tier: 370, label: "形影不離" } }) } : undefined));
    renderPage(<PersonSheet personId="P1" onClose={() => {}} />);
    const heart = await screen.findByRole("region", { name: "關係" });
    const ring = heart.querySelector('[data-bond-ring="ring"]');
    expect(ring?.querySelector("text")?.textContent).toBe("342");
    expect(ring?.querySelectorAll('[data-segment="lit"]')).toHaveLength(3);
    expect(within(heart).getByText("心有靈犀 III")).toBeInTheDocument();
    expect(within(heart).getByRole("meter", { name: "到「形影不離」60%" })).toBeInTheDocument();
    expect(within(heart).getByText("還沒有「形影不離」的共同記憶,停在門檻前")).toBeInTheDocument();
    for (const name of ["信任 62", "熟悉 48", "好感 +0.35", "敬意 −0.10", "自在 0.70", "心結 0.15", "想念 0.40", "默契 0.55"]) {
      expect(within(heart).getByRole("meter", { name })).toBeInTheDocument();
    }
    // Today's caps: only the numbers that moved today.
    expect(within(heart).getByRole("meter", { name: "羈絆 今天往上 3.5 / 6" })).toBeInTheDocument();
    expect(within(heart).queryByRole("meter", { name: /^信任 今天/ })).toBeNull();
    expect(screen.getByRole("region", { name: "證據" })).toHaveTextContent("在你的語音頻道一起待了 42 分鐘");
  });

  it("sets any number and keeps the quick steps for the bond", async () => {
    const bodies: unknown[] = [];
    mockFetch((method, url, body) => {
      if (method === "POST" && url.pathname === "/api/people/P1/adjust") {
        bodies.push(body);
        return { body: row("P1", "Ming", { bond: 350 }) };
      }
      if (url.pathname === "/api/people/P1") return { body: profile() };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<PersonSheet personId="P1" onClose={() => {}} />);
    const value = await screen.findByLabelText("羈絆的新值");
    expect(value).toHaveValue("342");
    await user.clear(value);
    await user.type(value, "2000");
    expect(screen.getByRole("button", { name: "設定" })).toBeDisabled();
    await user.clear(value);
    await user.type(value, "350");
    await user.click(screen.getByRole("button", { name: "設定" }));
    await waitFor(() => expect(bodies).toEqual([{ field: "bond", value: 350 }]));
    await user.click(within(screen.getByRole("group", { name: "調整羈絆" })).getByRole("button", { name: "+5" }));
    await waitFor(() => expect(bodies).toEqual([{ field: "bond", value: 350 }, { field: "bond", delta: 5 }]));
  });

  it("lists the changes with their cause and quote, and loads older ones a page at a time", async () => {
    const asked: string[] = [];
    mockFetch((_m, url) => {
      if (url.pathname === "/api/people/P1/history") {
        asked.push(url.search);
        return { body: { items: [change("E1", "grudge", -0.1, 0.15, "他道歉了,我也沒那麼氣了", "2026-11-09T12:00:00.000Z")], next_before: null } };
      }
      if (url.pathname === "/api/people/P1") return { body: profile() };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<PersonSheet personId="P1" onClose={() => {}} />);
    const history = await screen.findByRole("region", { name: "最近的變化" });
    expect(within(history).getByText("他接了我上次那個梗")).toBeInTheDocument();
    expect(within(history).getByText("+0.04")).toBeInTheDocument();
    expect(within(history).getByText("+1.5")).toBeInTheDocument();
    expect(within(history).getAllByText("對話中")).toHaveLength(2);
    expect(within(history).queryByText("他道歉了,我也沒那麼氣了")).toBeNull();
    expect(asked).toEqual([]);

    await user.click(within(history).getByRole("button", { name: "載入更多" }));
    expect(await within(history).findByText("他道歉了,我也沒那麼氣了")).toBeInTheDocument();
    expect(within(history).getByText("−0.1")).toBeInTheDocument();
    expect(asked).toEqual(["?before=E2&limit=20"]);
    await waitFor(() => expect(within(history).queryByRole("button", { name: "載入更多" })).toBeNull());
  });

  it("adds a shared memory for a tier and removes one after asking", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    mockFetch((method, url, body) => {
      if (url.pathname.startsWith("/api/people/P1/anchors/")) {
        calls.push({ method, path: url.pathname, body });
        return { body: [] };
      }
      if (url.pathname === "/api/people/P1") return { body: profile() };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<PersonSheet personId="P1" onClose={() => {}} />);
    const anchors = await screen.findByRole("region", { name: "分級的共同記憶" });
    expect(within(anchors).getByText("那天他陪我把整首歌練完")).toBeInTheDocument();

    await user.click(within(anchors).getByRole("button", { name: "新增共同記憶" }));
    const dialog = await screen.findByRole("dialog", { name: "新增共同記憶" });
    expect(within(dialog).getByRole("button", { name: "新增" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("記憶"), "第一次一起唱完一首歌");
    await user.click(within(dialog).getByRole("button", { name: "新增" }));
    await waitFor(() => expect(calls).toEqual([{ method: "PUT", path: "/api/people/P1/anchors/120", body: { quote: "第一次一起唱完一首歌" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新增共同記憶" })).toBeNull());

    await user.click(within(anchors).getByRole("button", { name: "「心有靈犀」的共同記憶的動作" }));
    await user.click(await screen.findByRole("menuitem", { name: "拿掉" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(calls).toHaveLength(1);
    await user.click(within(confirm).getByRole("button", { name: "拿掉" }));
    await waitFor(() => expect(calls[1]).toEqual({ method: "DELETE", path: "/api/people/P1/anchors/300", body: undefined }));
  });

  it("disables every change for a read-only account", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/people/P1" ? { body: profile() } : undefined));
    renderPage(<PersonSheet personId="P1" onClose={() => {}} />, { session: readOnly });
    const anchors = await screen.findByRole("region", { name: "分級的共同記憶" });
    expect(within(anchors).getByRole("button", { name: "新增共同記憶" })).toBeDisabled();
    expect(within(anchors).getByRole("button", { name: "「心有靈犀」的共同記憶的動作" })).toBeDisabled();
    expect(screen.getByLabelText("羈絆的新值")).toBeDisabled();
    expect(screen.getByRole("button", { name: "設定" })).toBeDisabled();
    expect(within(screen.getByRole("group", { name: "調整羈絆" })).getByRole("button", { name: "+5" })).toBeDisabled();
  });

  it("edits all of her words about them in one save", async () => {
    let saved: unknown;
    mockFetch((method, url, body) => {
      if (method === "PATCH" && url.pathname === "/api/people/P1") {
        saved = body;
        return { body: row("P1", "Ming") };
      }
      if (url.pathname === "/api/people/P1") return { body: profile() };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<PersonSheet personId="P1" onClose={() => {}} />);
    expect(await screen.findByLabelText("相處方式")).toHaveValue("會鬧他,但他認真的時候不鬧");
    await user.type(screen.getByLabelText("不喜歡的地方"), "常遲到");
    await user.clear(screen.getByLabelText("會員頁上的話"));
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(saved).toEqual({
        call_name: "小明",
        tags: ["常客"],
        impression: "記性很好,答應的事會做",
        stance: "會鬧他,但他認真的時候不鬧",
        unfinished: "他換工作的事",
        jokes: "香菜",
        dislikes: "常遲到",
        public_feeling: null,
      }),
    );
  });

  it("says there is nothing yet for someone without a row", async () => {
    mockFetch((_m, url) =>
      url.pathname === "/api/people/P1"
        ? { body: profile({ has_row: false, tier: "陌生人", tier_label: "陌生人", anchors: [], history: { items: [], next_before: null }, evidence: [] }) }
        : undefined,
    );
    renderPage(<PersonSheet personId="P1" onClose={() => {}} />);
    const heart = await screen.findByRole("region", { name: "關係" });
    expect(heart).toHaveTextContent("還沒有關係紀錄");
    expect(screen.queryByRole("region", { name: "分級的共同記憶" })).toBeNull();
    expect(screen.queryByRole("region", { name: "最近的變化" })).toBeNull();
  });
});

describe("heart helpers", () => {
  it("writes values and changes in each number's precision", () => {
    expect(fmtValue("bond", 342.4)).toBe("342");
    expect(fmtValue("bond", -40)).toBe("−40");
    expect(fmtValue("warmth", 0.35)).toBe("+0.35");
    expect(fmtValue("respect", -0.1)).toBe("−0.10");
    expect(fmtValue("ease", 0.7)).toBe("0.70");
    expect(fmtDelta("bond", 1.5)).toBe("+1.5");
    expect(fmtDelta("grudge", -0.1)).toBe("−0.1");
    expect(fmtDelta("trust", 0)).toBe("0");
  });

  it("reads typed values only inside each number's range", () => {
    expect(parseValue("bond", "1000")).toBe(1000);
    expect(parseValue("bond", "1001")).toBeNull();
    expect(parseValue("warmth", "−0.5")).toBe(-0.5);
    expect(parseValue("ease", "-0.1")).toBeNull();
    expect(parseValue("trust", "abc")).toBeNull();
  });

  it("offers anchors for the tiers reached and the next one when it needs one", () => {
    expect(anchorTiers({ bond: 342, tier_floor: 300, next_tier: "形影不離" }).map((t) => t.name)).toEqual([
      "知心",
      "知己",
      "至交",
      "莫逆之交",
      "心有靈犀",
      "形影不離",
    ]);
    expect(anchorTiers({ bond: 110, tier_floor: 100, next_tier: "知心" }).map((t) => t.name)).toEqual(["知心"]);
    expect(anchorTiers({ bond: 28, tier_floor: 15, next_tier: "好朋友" })).toEqual([]);
  });

  it("walks the levels back from each change's value after it", () => {
    const changes = [change("b", "bond", 2, 12, ""), change("a", "trust", 5, 55, "", "2026-11-09T12:00:00.000Z")];
    const { times, values } = levels(changes, ["bond", "trust"], { bond: 12, trust: 55 });
    expect(times).toEqual([Date.parse("2026-11-09T12:00:00.000Z"), Date.parse(AT)]);
    expect(values.trust).toEqual([55, 55]);
    expect(values.bond).toEqual([10, 12]);
  });
});
