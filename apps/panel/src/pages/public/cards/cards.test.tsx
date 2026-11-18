// 卡冊 on the member page (my cards, one card large, the dex, the odds, the wishlist), getting a new
// card in the rail when the Core says no, and a person's cards on the admin person sheet.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { CardCatalogue, CardDex, CardOdds, CataloguePart, IssuedCard, ListedCard, MyCard, PersonCards } from "@miyoria/contracts/api";
import { writeStorage } from "@/lib/storage";
import { CardsSection } from "@/pages/character/CardsSection";
import { mockFetch, renderPage } from "@/test/render";
import { CardSection } from "../CardSection";
import { CardsArea } from "./CardsArea";
import { catalogOf } from "./data";

const card = (over: Partial<IssuedCard>): IssuedCard => ({
  serial: "MYR-AAAA-0000-0001",
  // Noon UTC: the same date in any zone the tests run in.
  issued_at: "2026-11-17T12:00:00Z",
  name: "小魚乾",
  avatar_url: null,
  number: 1,
  call_name: "魚乾",
  relationship: "好朋友",
  affinity: "很喜歡",
  trust: "信任",
  familiarity: "熟",
  public_feeling: null,
  line: "今天也一起玩吧。",
  stamp: null,
  fields: [],
  pose: "smile",
  frame: null,
  foil: false,
  voided_at: null,
  rarity: null,
  parts: [],
  expression: null,
  ...over,
});

const SSR = card({
  serial: "MYR-SSR0-0000-0003",
  number: 3,
  kind: "daily",
  rarity: "SSR",
  foil: true,
  expression: "大牙",
  parts: [
    { id: "accessory.monocle_tail", slot: "accessory", name: "單片眼鏡和尾巴", rarity: "SSR" },
    { id: "background.aurora", slot: "background", name: "極光", rarity: "SSR" },
  ],
});
const DROP = card({
  serial: "MYR-DROP-0000-0002",
  number: 2,
  kind: "drop",
  rarity: "SR",
  expression: "臉紅",
  parts: [{ id: "background.fireworks", slot: "background", name: "頻道裡的煙火", rarity: "SR" }],
});
const OLD = card({ serial: "MYR-OLD0-0000-0001", number: 1, line: null });

const ONE: Record<string, MyCard> = {
  [SSR.serial]: { card: SSR, pity_hit: true, wished: ["background.aurora"], price: 80 },
  [DROP.serial]: { card: DROP, pity_hit: false, wished: [], price: 0 },
};

/** The list as the Core sends it: each card with what its page shows. */
const LISTED: ListedCard[] = [
  { ...SSR, pity_hit: true, wished: ["background.aurora"], price: 80, portrait: "live" },
  { ...DROP, pity_hit: false, wished: [], price: 0, portrait: "live" },
  { ...OLD, pity_hit: false, wished: [], price: 0, portrait: "fixed" },
];

const part = (id: string, name: string, rarity: CataloguePart["rarity"], series: [string, string] | null, more: Partial<CataloguePart> = {}): CataloguePart => ({
  id,
  slot: id.slice(0, id.indexOf(".")) as CataloguePart["slot"],
  name,
  rarity,
  series: series?.[0] ?? null,
  series_name: series?.[1] ?? null,
  drop_only: false,
  blank: false,
  enabled: true,
  wishable: true,
  ...more,
});
const GLASSES: [string, string] = ["glasses", "眼鏡系列"];
const CURIOS: [string, string] = ["curios", "怪東西系列"];
const SKY: [string, string] = ["sky", "天空系列"];
const CATALOGUE: CardCatalogue = {
  parts: [
    part("accessory.none", "無配件", "N", null, { blank: true, wishable: false }),
    part("accessory.monocle", "單片眼鏡", "SR", GLASSES),
    part("accessory.monocle_tail", "單片眼鏡和尾巴", "SSR", CURIOS),
    part("accessory.basin", "大鋼盆", "SR", CURIOS, { enabled: false, wishable: false }),
    part("background.stars", "星點", "R", SKY),
    part("background.aurora", "極光", "SSR", SKY),
    part("background.fireworks", "頻道裡的煙火", "SR", null, { drop_only: true }),
  ],
  series: [
    { id: "glasses", name: "眼鏡系列", title: "眼鏡控" },
    { id: "curios", name: "怪東西系列", title: "怪東西收藏家" },
    { id: "sky", name: "天空系列", title: "摘星的人" },
  ],
};

const DEX: CardDex = {
  parts: [
    { id: "accessory.monocle_tail", slot: "accessory", name: "單片眼鏡和尾巴", rarity: "SSR", series: "curios", count: 1, first_at: "2026-11-17T03:00:00Z" },
    { id: "background.aurora", slot: "background", name: "極光", rarity: "SSR", series: "sky", count: 2, first_at: "2026-11-17T03:00:00Z" },
    { id: "background.fireworks", slot: "background", name: "頻道裡的煙火", rarity: "SR", series: null, count: 1, first_at: "2026-11-16T03:00:00Z" },
  ],
  series: [
    { id: "sky", name: "天空系列", title: "摘星的人", owned: 1, total: 2, complete: false },
    { id: "curios", name: "怪東西系列", title: "怪東西收藏家", owned: 1, total: 1, complete: true },
  ],
  titles: [{ series: "curios", title: "怪東西收藏家", public: false, earned_at: "2026-11-17T03:00:00Z" }],
  legacy: { name: "舊收藏", items: [{ item: "hand_pot", name: "大鋼盆", rarity: "SR", series: "手上的東西", count: 1, first_at: "2026-09-01T00:00:00Z" }] },
};

const chance = (percent: number) => ({ percent, shown: percent.toFixed(2) });
const ODDS: CardOdds = {
  rarities: [
    { rarity: "N", ...chance(70) },
    { rarity: "R", ...chance(22) },
    { rarity: "SR", ...chance(7) },
    { rarity: "SSR", ...chance(1) },
  ],
  pity: { after: 20, rarities: [{ rarity: "SR", ...chance(87.5) }, { rarity: "SSR", ...chance(12.5) }] },
  slots: [
    {
      slot: "accessory",
      name: "配件",
      parts: [
        { id: "accessory.none", name: "無配件", rarity: "N", series: null, series_name: null, ...chance(60) },
        { id: "accessory.monocle", name: "單片眼鏡", rarity: "SR", series: "glasses", series_name: "眼鏡系列", ...chance(39.5) },
        { id: "accessory.monocle_tail", name: "單片眼鏡和尾巴", rarity: "SSR", series: "curios", series_name: "怪東西系列", ...chance(0.5) },
      ],
      empty: null,
    },
    {
      slot: "background",
      name: "背景",
      parts: [
        { id: "background.stars", name: "星點", rarity: "R", series: "sky", series_name: "天空系列", ...chance(99.7) },
        { id: "background.aurora", name: "極光", rarity: "SSR", series: "sky", series_name: "天空系列", ...chance(0.3) },
      ],
      empty: null,
    },
  ],
  price: 30,
  per_day: 5,
};

interface Options {
  /** Answer of the wishlist save. */
  wishSave?: { status?: number; body: unknown };
  /** The cards routes are not on this Core. */
  older?: boolean;
}

function core(o: Options = {}) {
  const puts: unknown[] = [];
  const titled: { series: string; body: unknown }[] = [];
  let wish = { parts: [{ id: "background.aurora", slot: "background", name: "極光", rarity: "SSR" }], max: 3 };
  const fn = mockFetch((method, url, body) => {
    const path = url.pathname;
    if (o.older && path.includes("/cards")) return undefined;
    if (path === "/api/member/wallet") return undefined;
    if (path === "/api/member/cards") return { body: { cards: LISTED } };
    if (path === "/api/member/cards/catalogue") return { body: CATALOGUE };
    const title = /^\/api\/member\/cards\/titles\/(.+)$/.exec(path);
    if (title && method === "PUT") {
      const series = decodeURIComponent(title[1] ?? "");
      titled.push({ series, body });
      const known = DEX.titles.find((t) => t.series === series);
      return known ? { body: { ...known, public: (body as { public: boolean }).public } } : { status: 404, body: { error: "你還沒有這個稱號" } };
    }
    if (path === "/api/member/cards/dex") return { body: DEX };
    if (path === "/api/member/cards/pity") return { body: { since: 7, pity: 20, until: 13 } };
    if (path === "/api/public/cards/odds") return { body: ODDS };
    if (path === "/api/member/cards/wishlist" && method === "PUT") {
      puts.push(body);
      if (o.wishSave) return o.wishSave;
      const ids = (body as { parts: string[] }).parts;
      wish = { parts: ids.map((id) => ({ id, slot: id.split(".")[0] ?? "", name: id, rarity: "N" })), max: 3 };
      return { body: wish };
    }
    if (path === "/api/member/cards/wishlist") return { body: wish };
    return undefined;
  });
  return { fn, puts, titled };
}

afterEach(() => writeStorage("miyoria.member.cards-tab", null));

const area = () => screen.findByRole("region", { name: "卡冊" });

describe("卡冊: their cards", () => {
  it("shows every card with its kind and rarity, older cards too, and filters by kind", async () => {
    core();
    renderPage(<CardsArea />);
    const a = await area();
    expect(await within(a).findByRole("button", { name: /每日卡 第 3 張 SSR 閃卡/ })).toBeInTheDocument();
    expect(within(a).getByRole("button", { name: /掉落的卡 第 2 張 SR/ })).toBeInTheDocument();
    expect(within(a).getByRole("button", { name: /舊卡 第 1 張/ })).toBeInTheDocument();
    await userEvent.click(within(a).getByRole("radio", { name: "掉落的卡 1" }));
    expect(within(a).queryByRole("button", { name: /每日卡 第 3 張/ })).toBeNull();
    expect(within(a).getByRole("button", { name: /掉落的卡 第 2 張/ })).toBeInTheDocument();
  });

  it("opens one card large with its parts, expression, date, code, what it cost and the pity", async () => {
    const { fn } = core();
    renderPage(<CardsArea />);
    const a = await area();
    await userEvent.click(await within(a).findByRole("button", { name: /每日卡 第 3 張 SSR/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img", { name: /MYR-SSR0-0000-0003/ })).toBeInTheDocument();
    const parts = within(dialog).getByRole("region", { name: "抽到的部件" });
    expect(within(parts).getByText("單片眼鏡和尾巴")).toBeInTheDocument();
    expect(within(parts).getByText("極光")).toBeInTheDocument();
    // The wished part it brought.
    expect(within(parts).getByText("願望")).toBeInTheDocument();
    expect(within(dialog).getByText("大牙")).toBeInTheDocument();
    expect(within(dialog).getByText("2026.11.17")).toBeInTheDocument();
    expect(within(dialog).getByText("MYR-SSR0-0000-0003")).toBeInTheDocument();
    expect(await within(dialog).findByText("80 魚幣")).toBeInTheDocument();
    expect(within(dialog).getByText("這張由保底決定")).toBeInTheDocument();
    // Foil: the light layers sit over the card.
    expect(dialog.querySelector(".holo-foil")).not.toBeNull();
    // Everything came with the list: no request per card.
    const asked = fn.mock.calls.map((c) => new URL(String(c[0]), "http://panel.test").pathname);
    expect(asked.filter((p) => p.startsWith("/api/member/card/"))).toEqual([]);
  });

  it("says plainly when the Core has no 卡冊 yet", async () => {
    core({ older: true });
    renderPage(<CardsArea />);
    expect(await within(await area()).findByText("這個 Core 還沒有卡冊")).toBeInTheDocument();
  });
});

describe("卡冊: the dex", () => {
  it("shows owned parts with counts, the rest locked by name and rarity, series, titles and 舊收藏", async () => {
    core();
    renderPage(<CardsArea />);
    const a = await area();
    await userEvent.click(within(a).getByRole("tab", { name: "圖鑑" }));
    expect(await within(a).findByRole("listitem", { name: "極光,SSR,有 2 張" })).toBeInTheDocument();
    expect(within(a).getByRole("listitem", { name: "單片眼鏡,SR,還沒有" })).toBeInTheDocument();
    // A blank part ("無配件") is not collected, nor a disabled one they never had; a drop-only
    // part they caught is.
    expect(within(a).queryByRole("listitem", { name: /^無配件/ })).toBeNull();
    expect(within(a).queryByRole("listitem", { name: /^大鋼盆/ })).toBeNull();
    expect(within(a).getByRole("listitem", { name: "頻道裡的煙火,SR,有 1 張" })).toBeInTheDocument();
    const series = within(a).getByRole("region", { name: "系列" });
    expect(within(series).getByRole("meter", { name: "天空系列 1/2" })).toBeInTheDocument();
    expect(within(series).getByText("稱號「怪東西收藏家」")).toBeInTheDocument();
    expect(within(a).getByRole("region", { name: "稱號" })).toHaveTextContent("只有你看得到");
    expect(within(within(a).getByRole("region", { name: "舊收藏" })).getByText("大鋼盆")).toBeInTheDocument();
  });

  it("groups parts by the catalogue's series, named", async () => {
    core();
    renderPage(<CardsArea />);
    const a = await area();
    await userEvent.click(within(a).getByRole("tab", { name: "圖鑑" }));
    await userEvent.click(await within(a).findByRole("radio", { name: "依系列" }));
    const glasses = within(a).getByRole("region", { name: "眼鏡系列" });
    expect(within(glasses).getByRole("listitem", { name: "單片眼鏡,SR,還沒有" })).toBeInTheDocument();
    expect(within(within(a).getByRole("region", { name: "不屬於系列" })).getByRole("listitem", { name: /頻道裡的煙火/ })).toBeInTheDocument();
  });

  it("shows a title to others, or keeps it theirs, through the Core", async () => {
    const { titled } = core();
    renderPage(<CardsArea />);
    const a = await area();
    await userEvent.click(within(a).getByRole("tab", { name: "圖鑑" }));
    const titles = await within(a).findByRole("region", { name: "稱號" });
    const toggle = within(titles).getByRole("switch", { name: "「怪東西收藏家」給別人看" });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(titled).toEqual([{ series: "curios", body: { public: true } }]));
    expect(await within(titles).findByText("公開")).toBeInTheDocument();
    expect(within(titles).getByRole("switch", { name: "「怪東西收藏家」給別人看" })).toBeChecked();
  });
});

describe("卡冊: the odds", () => {
  it("prints the rarity chances, the pity's, each slot's parts and their own pity counter", async () => {
    core();
    renderPage(<CardsArea />);
    const a = await area();
    await userEvent.click(within(a).getByRole("tab", { name: "機率表" }));
    expect(await within(a).findByText("再 13 張保證 SR 以上")).toBeInTheDocument();
    const rarity = within(a).getByRole("region", { name: "稀有度" });
    expect(within(rarity).getByText("70.00%")).toBeInTheDocument();
    expect(within(rarity).getByText("87.50%")).toBeInTheDocument();
    const acc = within(a).getByRole("list", { name: "配件的部件機率" });
    expect(within(acc).getByText("單片眼鏡和尾巴")).toBeInTheDocument();
    expect(within(acc).getByText("0.50%")).toBeInTheDocument();
  });
});

describe("卡冊: the wishlist", () => {
  it("adds a part from the catalogue, saves the ids in order, and clears", async () => {
    const { puts } = core();
    renderPage(<CardsArea />);
    const a = await area();
    await userEvent.click(within(a).getByRole("tab", { name: "願望單" }));
    await userEvent.click(await within(a).findByRole("button", { name: "單片眼鏡 SR" }));
    await userEvent.click(within(a).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(puts).toEqual([{ parts: ["background.aurora", "accessory.monocle"] }]));
    await userEvent.click(within(a).getByRole("button", { name: "清空" }));
    await waitFor(() => expect(puts.at(-1)).toEqual({ parts: [] }));
    expect(await within(a).findByText("還沒有願望")).toBeInTheDocument();
  });

  it("offers what the Core marks wishable: a drop-only part, never a blank or a disabled one", async () => {
    core();
    renderPage(<CardsArea />);
    const a = await area();
    await userEvent.click(within(a).getByRole("tab", { name: "願望單" }));
    const pick = await within(a).findByRole("region", { name: "挑部件" });
    expect(within(pick).getByRole("button", { name: "頻道裡的煙火 SR,已經有了" })).toBeInTheDocument();
    expect(within(pick).queryByRole("button", { name: /^無配件/ })).toBeNull();
    expect(within(pick).queryByRole("button", { name: /^大鋼盆/ })).toBeNull();
  });

  it("shows the Core's sentence when it will not take the list", async () => {
    core({ wishSave: { status: 400, body: { error: "願望單最多三個" } } });
    renderPage(<CardsArea />);
    const a = await area();
    await userEvent.click(within(a).getByRole("tab", { name: "願望單" }));
    await userEvent.click(await within(a).findByRole("button", { name: "星點 R" }));
    await userEvent.click(within(a).getByRole("button", { name: "儲存" }));
    expect(await within(a).findByRole("alert")).toHaveTextContent("願望單最多三個");
  });
});

describe("the catalogue", () => {
  it("is the Core's: no blank part, a disabled one only once owned, drop-only parts kept", () => {
    const ids = catalogOf(DEX, CATALOGUE).map((p) => p.id);
    expect(ids).not.toContain("accessory.none");
    expect(ids).not.toContain("accessory.basin");
    expect(ids).toContain("background.fireworks");
    expect(ids).toContain("accessory.monocle");
    const owned = { ...DEX, parts: [...DEX.parts, { id: "accessory.basin", slot: "accessory" as const, name: "大鋼盆", rarity: "SR" as const, series: "curios", count: 1, first_at: "2026-11-01T00:00:00Z" }] };
    expect(catalogOf(owned, CATALOGUE).find((p) => p.id === "accessory.basin")).toMatchObject({ count: 1, wishable: false });
    // Without the catalogue (an older Core), only their own.
    expect(catalogOf(DEX, undefined).map((p) => p.id).sort()).toEqual(DEX.parts.map((p) => p.id).sort());
  });
});

describe("getting a new card", () => {
  it("shows the price, what is left today, their coins and the pity, and the Core's sentence on a refusal", async () => {
    mockFetch((method, url) => {
      if (url.pathname === "/api/member/card" && method === "POST") return { status: 409, body: { error: "今天的卡已經抽完了" } };
      if (url.pathname === "/api/member/card") {
        return { body: { latest: SSR, today: 2, per_day: 5, prices: { card: 30, foil: null }, balance: 100, pity: { since: 7, pity: 20, until: 13 } } };
      }
      return undefined;
    });
    renderPage(<CardSection />);
    const rail = await screen.findByRole("region", { name: "她給你的卡" });
    expect(await within(rail).findByText("3 / 5 張")).toBeInTheDocument();
    expect(within(rail).getByText("再 13 張")).toBeInTheDocument();
    await userEvent.click(within(rail).getByRole("button", { name: /抽一張新卡/ }));
    expect(await within(rail).findByRole("alert")).toHaveTextContent("今天的卡已經抽完了");
  });

  it("does not ask when their coins are short", async () => {
    mockFetch((_m, url) =>
      url.pathname === "/api/member/card"
        ? { body: { latest: null, today: 0, per_day: 5, prices: { card: 30, foil: null }, balance: 12, pity: null } }
        : undefined,
    );
    renderPage(<CardSection />);
    const rail = await screen.findByRole("region", { name: "她給你的卡" });
    expect(await within(rail).findByRole("button", { name: /抽一張新卡/ })).toBeDisabled();
    expect(within(rail).getByRole("alert")).toHaveTextContent("不夠,這張要 30");
  });
});

describe("a person's cards on the admin sheet", () => {
  const data: PersonCards = {
    cards: [ONE[SSR.serial] as MyCard, ONE[DROP.serial] as MyCard],
    dex: DEX,
    pity: { since: 7, pity: 20, until: 13 },
    wishlist: [{ id: "background.aurora", slot: "background", name: "極光", rarity: "SSR" }],
  };

  it("lists their cards with what each cost, the pity, the wishlist and the series", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/people/P1/cards" ? { body: data } : undefined));
    renderPage(<CardsSection personId="P1" />);
    const s = await screen.findByRole("region", { name: "卡片" });
    expect(await within(s).findByText("80 魚幣")).toBeInTheDocument();
    expect(within(s).getByText("不用錢")).toBeInTheDocument();
    // The row's mark beside the 保底 fact.
    expect(within(s).getAllByText("保底")).toHaveLength(2);
    expect(within(s).getByText("再 13 張保證 SR 以上")).toBeInTheDocument();
    expect(within(s).getByText("極光")).toBeInTheDocument();
    expect(within(s).getByRole("meter", { name: "天空系列 1/2" })).toBeInTheDocument();
    expect(within(s).getByRole("link", { name: /MYR-SSR0-0000-0003/ })).toHaveAttribute("href", expect.stringContaining("/card/MYR-SSR0-0000-0003"));
  });

  it("is left out on a Core without the cards module", async () => {
    const fn = mockFetch(() => undefined);
    const { container } = renderPage(<CardsSection personId="P1" />);
    await waitFor(() => expect(fn).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[aria-label="卡片"]')).toBeNull());
    expect(screen.queryByText("載入中")).toBeNull();
  });
});
