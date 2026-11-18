// `/me card`: neutral answers over the Keepsakes service (today's card, another one, foil, the dex,
// the odds, the pity and the wishlist), and the hub page.

import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type KeepsakeCard,
  type KeepsakeCardBook,
  type KeepsakeCardImage,
  type KeepsakeCardOrder,
  type KeepsakeCards,
  type KeepsakeFortune,
  type KeepsakeOdds,
  type KeepsakeResult,
  type Keepsakes,
  KeepsakesKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  CommandRegistry,
  type CommandReply,
  Invocation,
  Permissions,
  panelDefs,
  registerKeepsakes,
  splitPath,
} from "../src/index.js";
import { guildContext } from "./helpers.js";

const card = (number: number): KeepsakeCard => ({
  serial: `MYR-TEST-0000-000${number}`,
  number,
  issued_at: "2026-11-10T00:00:00.000Z",
  relationship: "好朋友",
  line: "今天也辛苦了",
  stamp: null,
  fields: [{ label: "願望", text: "會實現" }],
  foil: false,
  rarity: "SR",
  parts: ["貓", "星空"],
  expression: "微笑",
});

const ODDS: KeepsakeOdds = {
  rarities: [
    { rarity: "N", shown: "70.00" },
    { rarity: "R", shown: "24.00" },
    { rarity: "SR", shown: "5.00" },
    { rarity: "SSR", shown: "1.00" },
  ],
  pity_after: 30,
  price: 30,
  per_day: 5,
  slots: [{ name: "手上", parts: [{ name: "貓", rarity: "SR", shown: "2.50" }] }],
};

/** Parts the fake knows by name. */
const PARTS = ["貓", "星空", "眼鏡", "圍巾"];

const SLIP: KeepsakeFortune = {
  id: "f1",
  date: "2026-11-10",
  rank: "大吉",
  title: "春風得意",
  poem: ["月落烏啼", "江楓漁火", "姑蘇城外", "夜半鐘聲"],
  fields: [],
  line: "今天也辛苦了",
};

class Fake implements Keepsakes {
  issued: KeepsakeCard[] = [];
  keys: string[] = [];
  slip: KeepsakeFortune | null = null;
  refuse: { status: number; message: string } | null = null;
  wishlist: string[] = [];
  odds: KeepsakeOdds | null = ODDS;
  /** A keepsake the next look gives. */
  keepsake: KeepsakeCard | null = null;

  async fortuneToday() {
    return { fortune: this.slip, price: 10 };
  }

  async drawFortune(_who: unknown, key: string): Promise<KeepsakeResult<KeepsakeFortune>> {
    this.keys.push(key);
    if (this.refuse) return { ok: false, ...this.refuse };
    const first = this.slip === null;
    this.slip = SLIP;
    return { ok: true, value: SLIP, charged: first ? 10 : 0, balance: 20 };
  }

  async cardsToday(): Promise<KeepsakeCards> {
    const keepsake = this.keepsake;
    this.keepsake = null;
    return {
      latest: keepsake ?? this.issued.at(-1) ?? null,
      today: this.issued.length,
      per_day: 5,
      prices: { card: 30, foil: 50 },
      pity: { since: this.issued.length, pity: 30, until: 30 - this.issued.length },
      ...(keepsake === null ? {} : { keepsake }),
    };
  }

  /** Every card costs 30, foil 50 more, from 200 coins. */
  async issueCard(
    _who: unknown,
    key: string,
    order: KeepsakeCardOrder = {},
  ): Promise<KeepsakeResult<KeepsakeCard>> {
    this.keys.push(key);
    if (this.refuse) return { ok: false, ...this.refuse };
    const made = { ...card(this.issued.length + 1), foil: order.foil === true };
    this.issued.push(made);
    const spent = this.issued.reduce((n, c) => n + (c.foil ? 80 : 30), 0);
    return { ok: true, value: made, charged: made.foil ? 80 : 30, balance: 200 - spent };
  }

  async cardBook(): Promise<KeepsakeResult<KeepsakeCardBook>> {
    if (this.refuse) return { ok: false, ...this.refuse };
    return {
      ok: true,
      value: {
        series: [
          { name: "貓咪系列", owned: 3, total: 3, title: "貓奴", complete: true },
          { name: "星空系列", owned: 1, total: 4, title: "觀星者", complete: false },
        ],
        parts: { owned: 4, total: 40 },
        titles: ["貓奴"],
        legacy: [
          { name: "黑框眼鏡", count: 2 },
          { name: "極光", count: 1 },
        ],
        pity: { since: 28, pity: 30, until: 2 },
        wishlist: this.wishlist,
      },
      charged: 0,
      balance: null,
    };
  }

  async cardOdds(): Promise<KeepsakeOdds | null> {
    return this.odds;
  }

  /** The picture of a card, once a test turns it on (a service without `cardImage` has none). */
  pictures: string[] | null = null;
  asked: string[] = [];
  broken = false;

  async cardImage(serial: string): Promise<KeepsakeCardImage | null> {
    this.asked.push(serial);
    if (this.broken) throw new Error("cannot draw");
    if (this.pictures === null || !this.pictures.includes(serial)) return null;
    return {
      name: `miyoria-card-${serial}.png`,
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
    };
  }

  drops = new Map<string, string>();

  async claimDrop(who: { name: string }, drop: string): Promise<KeepsakeResult<KeepsakeCard>> {
    const taker = this.drops.get(drop);
    if (taker !== undefined && taker !== who.name) {
      return { ok: false, status: 409, message: "被別人先撿走了" };
    }
    this.drops.set(drop, who.name);
    return { ok: true, value: { ...card(9), kind: "drop" }, charged: 0, balance: null };
  }

  async setCardWishlist(
    _who: unknown,
    parts: readonly string[],
  ): Promise<KeepsakeResult<string[]>> {
    if (parts.length > 3) return { ok: false, status: 400, message: "願望單最多三個" };
    const unknown = parts.find((p) => !PARTS.includes(p));
    if (unknown) return { ok: false, status: 400, message: `沒有這個部件:${unknown}` };
    this.wishlist = [...parts];
    return { ok: true, value: this.wishlist, charged: 0, balance: null };
  }
}

function setup(withService = true) {
  const services = new ServiceRegistry();
  const fake = new Fake();
  if (withService) services.provide("test", KeepsakesKey, fake);
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"])).withServices(
    services,
  );
  registerKeepsakes(registry, services);
  const run = (path: string, args: Record<string, string | boolean> = {}) =>
    registry.dispatch(
      new Invocation({
        path: splitPath(path),
        args,
        invoker: { platform: "discord", id: "1" },
        invoker_display_name: "Owen",
        context: guildContext,
        invoker_is_guild_admin: false,
      }),
    );
  return { registry, fake, run };
}

describe("me card's picture", () => {
  const SERIAL = "MYR-TEST-0000-0001";

  it("goes on top of the card, new or shown again, as a file only they get", async () => {
    const { run, fake } = setup();
    fake.pictures = [SERIAL];
    const first = await run("me card");
    expect(first.files?.map((f) => [f.name, f.contentType])).toEqual([
      [`miyoria-card-${SERIAL}.png`, "image/png"],
    ]);
    expect(first.card?.blocks[0]).toEqual({ type: "image", name: `miyoria-card-${SERIAL}.png` });
    expect(first.text).toContain("第 1 張");
    const again = await run("me card");
    expect(again.files).toHaveLength(1);
    expect(again.card?.blocks[0]?.type).toBe("image");
    expect(fake.asked).toEqual([SERIAL, SERIAL]);
  });

  it("is on the keepsake card of someone from before the cards", async () => {
    const { run, fake } = setup();
    fake.pictures = ["MYR-TEST-0000-0007"];
    fake.keepsake = { ...card(7), kind: "keepsake" };
    const kept = await run("me card");
    expect(kept.files).toHaveLength(1);
    expect(kept.text).toContain("紀念卡");
  });

  it("is left out when the card cannot be drawn, and the words still come", async () => {
    const { run, fake } = setup();
    const none = await run("me card");
    expect(none.files).toBeUndefined();
    expect(none.card?.blocks.some((b) => b.type === "image")).toBe(false);
    expect(none.text).toContain("第 1 張");
    fake.broken = true;
    const failed = await run("me card");
    expect(failed.files).toBeUndefined();
    expect(failed.text).toContain("第 1 張");
  });
});

describe("me card", () => {
  it("issues one when there is none today and shows today's after that", async () => {
    const { run, fake, registry } = setup();
    expect(registry.get(["me", "card"])?.ephemeral).toBe(true);
    const first = await run("me card");
    expect(first.card?.accent).toBe("neutral");
    expect(first.text).toContain("第 1 張　SR　好朋友");
    expect(first.text).toContain("今天也辛苦了");
    // Her expression and the parts drawn onto it.
    expect(first.text).toContain("微笑・貓・星空");
    expect(first.text).toContain("MYR-TEST-0000-0001");
    // The first card of the day is paid too.
    expect(first.text).toContain("花了 30，剩 170");
    const again = await run("me card");
    expect(again.text).toContain("第 1 張");
    expect(again.text).toContain("今天發了 1 / 5 張");
    expect(again.text).not.toContain("花了");
    expect(fake.issued).toHaveLength(1);
    expect(fake.keys[0]).toMatch(/^discord:/);
  });

  it("issues another one today, as a foil card when asked, and says what it cost", async () => {
    const { run, fake } = setup();
    await run("me card");
    const shown = await run("me card");
    expect(shown.text).toContain("再一張用 action:再發一張（30，加 foil 做成閃卡（再 50））");
    expect(shown.text).toContain("圖鑑、機率、保底和願望單也在 action 裡");
    expect(shown.text).not.toContain("重抽");
    const plain = await run("me card", { action: "再發一張" });
    expect(plain.text).toContain("第 2 張");
    expect(plain.text).toContain("花了 30，剩 140");
    // foil alone means a new card too.
    const foil = await run("me card", { foil: true });
    expect(foil.text).toContain("第 3 張　SR　好朋友　閃卡");
    expect(foil.text).toContain("花了 80，剩 60");
    expect(fake.issued.map((c) => c.foil)).toEqual([false, false, true]);
  });

  it("names a card she gave for something else than a purchase", async () => {
    const { run, fake } = setup();
    await run("me card");
    fake.issued.push({ ...card(2), kind: "milestone" });
    expect((await run("me card")).text).toContain("第 2 張　里程碑卡　SR　好朋友");
  });

  it("shows a keepsake on the first look of someone from before, and issues nothing", async () => {
    const { run, fake } = setup();
    fake.keepsake = { ...card(1), kind: "keepsake", line: null };
    const first = await run("me card");
    expect(first.text).toContain("第 1 張　紀念卡　SR　好朋友");
    expect(first.text).toContain("紀念卡，不用魚幣");
    expect(first.text).not.toContain("花了");
    expect(fake.issued).toEqual([]);
    // The next look is the usual one.
    expect((await run("me card")).text).toContain("花了 30");
  });

  it("routes a dropped card's button: the card to its taker alone, who got it to the channel", async () => {
    const { registry } = setup();
    const press = (id: string, name: string, followUp?: (r: CommandReply) => Promise<void>) =>
      registry.dispatchComponent(
        {
          custom_id: `mi:cards:drop:${id}`,
          invoker: { platform: "discord", id: "1" },
          invoker_display_name: name,
          context: guildContext,
          invoker_is_guild_admin: false,
        },
        followUp ? { followUp } : {},
      );
    const private_: CommandReply[] = [];
    const won = await press("D1", "Owen", async (r) => {
      private_.push(r);
    });
    expect(won?.result.type).toBe("update");
    expect(won?.result.type === "update" && won.result.reply.text).toContain("Owen 撿走了這張卡");
    expect(private_).toHaveLength(1);
    expect(private_[0]?.ephemeral).toBe(true);
    expect(private_[0]?.text).toContain("頻道裡撿到的卡");
    const late = await press("D1", "Mia");
    expect(late?.result.type).toBe("reply");
    expect(late?.ephemeral).toBe(true);
    expect(late?.result.type === "reply" && late.result.reply.text).toBe("被別人先撿走了");
  });

  it("offers the dex, the odds, the pity and the wishlist, and no reroll", () => {
    const { registry } = setup();
    const spec = registry.get(["me", "card"]);
    expect(spec?.args.map((a) => a.name)).toEqual(["action", "foil", "wish"]);
    expect(spec?.args.find((a) => a.name === "action")?.kind).toEqual({
      type: "choice",
      choices: ["再發一張", "圖鑑", "機率", "保底", "願望單"],
    });
  });

  it("shows the dex: parts, series with their titles, the old collectibles, pity and wishes", async () => {
    const { run, fake } = setup();
    const dex = await run("me card", { action: "圖鑑" });
    expect(dex.card?.accent).toBe("neutral");
    expect(dex.text).toContain("收集到 4 / 40 種部件。");
    expect(dex.text).toContain("貓咪系列：3 / 3（稱號「貓奴」）");
    expect(dex.text).toContain("星空系列：1 / 4");
    // A title shows only once the series is complete.
    expect(dex.text).not.toContain("觀星者");
    expect(dex.text).toContain("舊收藏：黑框眼鏡×2、極光");
    expect(dex.text).toContain("連續 28 張沒有 SR 以上；再 2 張還沒有的話，下一張保證有。");
    expect(dex.text).toContain("願望單是空的");
    fake.wishlist = ["貓"];
    expect((await run("me card", { action: "圖鑑" })).text).toContain("願望單：貓（不改機率");
    // Looking issues nothing.
    expect(fake.issued).toEqual([]);
  });

  it("prints the public odds, and says so when there are none", async () => {
    const { run, fake } = setup();
    const odds = await run("me card", { action: "機率" });
    expect(odds.card?.accent).toBe("neutral");
    expect(odds.text).toContain("一張 30，一天最多 5 張。");
    expect(odds.text).toContain("N 70.00%　R 24.00%　SR 5.00%　SSR 1.00%");
    expect(odds.text).toContain("連續 30 張沒有 SR 以上，下一張保證有。");
    expect(odds.text).toContain("手上：貓 2.50%");
    expect(odds.text).toContain("機率對每個人都一樣");
    fake.odds = null;
    expect((await run("me card", { action: "機率" })).text).toBe("這個功能現在不能用。");
    expect(fake.issued).toEqual([]);
  });

  it("tells the pity in a sentence", async () => {
    const { run, fake } = setup();
    const pity = await run("me card", { action: "保底" });
    expect(pity.tone).toBe("info");
    expect(pity.text).toBe("連續 28 張沒有 SR 以上；再 2 張還沒有的話，下一張保證有。");
    expect(fake.issued).toEqual([]);
  });

  it("shows the wishlist without wish, sets it with one, and clears it with 清空", async () => {
    const { run, fake } = setup();
    expect((await run("me card", { action: "願望單" })).text).toContain("願望單是空的");
    const set = await run("me card", { action: "願望單", wish: "貓、星空, 眼鏡" });
    expect(set.text).toBe("願望單：貓、星空、眼鏡。機率不會變，抽到時她會知道。");
    expect(fake.wishlist).toEqual(["貓", "星空", "眼鏡"]);
    expect((await run("me card", { action: "願望單" })).text).toBe("願望單：貓、星空、眼鏡");
    // A refusal is shown as it is, and changes nothing.
    const many = await run("me card", { action: "願望單", wish: "貓、星空、眼鏡、圍巾" });
    expect(many.text).toBe("願望單最多三個");
    expect(many.tone).toBe("info");
    expect((await run("me card", { action: "願望單", wish: "龍" })).text).toBe("沒有這個部件:龍");
    expect(fake.wishlist).toEqual(["貓", "星空", "眼鏡"]);
    const cleared = await run("me card", { action: "願望單", wish: "清空" });
    expect(cleared.text).toBe("願望單清空了。");
    expect(fake.wishlist).toEqual([]);
    // `wish:` without an action is the wishlist too, never a card bought.
    expect((await run("me card", { wish: "貓" })).text).toBe(
      "願望單：貓。機率不會變，抽到時她會知道。",
    );
    expect(fake.issued).toEqual([]);
  });

  it("answers a refusal as plain information, and a failure as a warning", async () => {
    const { run, fake } = setup();
    fake.refuse = { status: 402, message: "魚幣不夠" };
    const poor = await run("me card");
    expect(poor.text).toBe("魚幣不夠");
    expect(poor.tone).toBe("info");
    fake.refuse = { status: 429, message: "今天的卡已經發完了,明天再來" };
    const full = await run("me card");
    expect(full.text).toBe("今天的卡已經發完了,明天再來");
    expect(full.tone).toBe("info");
    fake.refuse = { status: 503, message: "這個 Core 還不能發卡" };
    expect((await run("me card")).tone).toBe("warn");
    expect((await run("me card", { action: "圖鑑" })).tone).toBe("warn");
  });

  it("says so plainly when the api is not running", async () => {
    const { run } = setup(false);
    expect((await run("me card")).text).toBe("這個功能現在不能用。");
    expect((await run("me card", { action: "機率" })).text).toBe("這個功能現在不能用。");
  });
});

describe("the me panel", () => {
  it("has a page for the card, over a command that exists", () => {
    const me = panelDefs().find((d) => d.command === "me");
    const page = me?.pages.find((p) => p.id === "keepsakes");
    expect(page?.actions.map((a) => a.path)).toEqual(["me card"]);
  });
});
