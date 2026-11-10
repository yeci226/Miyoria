// Collecting: the published odds, drawing and its pity, the album, the traits of a portrait card,
// giving spares away, and the tools and commands over it.

import { CommandRegistry, Permissions } from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/kernel";
import type { AccountRef } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands } from "../src/commands.js";
import { v2Capabilities } from "../src/v2-tools.js";
import { Economy2Key } from "../src/v2-types.js";
import {
  ALICE,
  ALICE_TWO,
  BOB,
  balance,
  CAROL,
  DAVE,
  DAY,
  ERIN,
  fund,
  type Rig,
  rejects,
  rig,
  say,
  TEXT,
} from "./rig.js";

/** Two series, one item of each rarity in the first, so a pinned die picks a known thing. */
const SERIES = [
  {
    id: "a",
    label: "甲系列",
    title: "甲收藏家",
    items: [
      { id: "a_n", label: "甲N", rarity: "N" },
      { id: "a_r", label: "甲R", rarity: "R" },
      { id: "a_sr", label: "甲SR", rarity: "SR" },
      { id: "a_ssr", label: "甲SSR", rarity: "SSR" },
    ],
  },
  {
    id: "b",
    label: "乙系列",
    title: "乙收藏家",
    items: [{ id: "b_n", label: "乙N", rarity: "N" }],
  },
];

const cfg = (extra: Record<string, unknown> = {}) =>
  ({ collection_series: SERIES, achievement_cap: 0, ...extra }) as never;

/** Every die the draw rolls is `value`. */
function dice(r: Rig, ...values: number[]) {
  r.dice.values = values;
}

describe("the odds", () => {
  it("are the configured weights as percentages, and drop a rarity with nothing in it", async () => {
    const r = await rig();
    const odds = r.economy.v2.odds();
    expect(odds.map((o) => [o.rarity, o.percent])).toEqual([
      ["N", 70],
      ["R", 22],
      ["SR", 7],
      ["SSR", 1],
    ]);
    // Without an SSR item its 1% goes to the others: the table still adds up to 100.
    const noTop = await rig(
      cfg({
        collection_series: [{ ...SERIES[0], items: SERIES[0]?.items.slice(0, 3) }],
      }),
    );
    const rows = noTop.economy.v2.odds();
    expect(rows.map((o) => o.rarity)).toEqual(["N", "R", "SR"]);
    expect(rows.reduce((n, o) => n + o.percent, 0)).toBeCloseTo(100, 1);
    // A card's rarity is rolled by the raw weights.
    expect(r.economy.v2.rarityOdds().map((o) => o.percent)).toEqual([70, 22, 7, 1]);
  });

  it("roll a card's rarity by those weights", async () => {
    const r = await rig();
    const roll = (die: number) => {
      dice(r, die);
      return r.economy.v2.rollRarity();
    };
    expect([
      roll(0),
      roll(0.69),
      roll(0.7),
      roll(0.91),
      roll(0.92),
      roll(0.99),
      roll(0.999),
    ]).toEqual(["N", "N", "R", "R", "SR", "SSR", "SSR"]);
  });
});

describe("drawing", () => {
  it("charges the price, writes the item and answers a repeated key with the same draw", async () => {
    const r = await rig(cfg());
    await fund(r, ALICE, 100);
    dice(r, 0.75, 0); // R
    const first = await r.economy.v2.draw(ALICE, "k1");
    expect(first).toMatchObject({
      item: { id: "a_r", rarity: "R", series: "甲系列" },
      charged: 30,
      balance: 70,
      duplicate: false,
      new: true,
    });
    const again = await r.economy.v2.draw(ALICE, "k1");
    expect(again).toMatchObject({ duplicate: true, charged: 30, balance: 70 });
    expect(again.item.id).toBe("a_r");
    expect(await balance(r, ALICE)).toBe(70);
    expect((await r.economy.wallet(ALICE)).recent[0]?.label).toBe("抽收藏");
    const album = await r.economy.v2.album(ALICE);
    expect(album.series[0]?.items.find((i) => i.id === "a_r")?.owned).toBe(1);
    // A second copy is not new.
    dice(r, 0.75, 0);
    expect(await r.economy.v2.draw(ALICE, "k2")).toMatchObject({ new: false });
  });

  it("refuses a stranger, an empty purse and the day's limit, charging nothing", async () => {
    const r = await rig(cfg({ draws_per_day: 2 }));
    await rejects(r.economy.v2.draw(DAVE, "k"), 403);
    await rejects(r.economy.v2.draw(CAROL, "k"), 403);
    await rejects(r.economy.v2.draw(ALICE, "k"), 402);
    await fund(r, ALICE, 500);
    await r.economy.v2.draw(ALICE, "1");
    await r.economy.v2.draw(ALICE, "2");
    await rejects(r.economy.v2.draw(ALICE, "3"), 429, /最多抽 2 次/);
    expect(await balance(r, ALICE)).toBe(440);
    r.clock.at += DAY;
    await r.economy.v2.draw(ALICE, "4");
    // The limit counts the person, not the account.
    await fund(r, BOB, 100);
    await r.economy.v2.draw(BOB, "b1");
    await r.economy.v2.draw(BOB, "b2");
    await rejects(r.economy.v2.draw(BOB, "b3"), 429);
    await fund(r, ALICE_TWO, 100);
    await r.economy.v2.draw(ALICE_TWO, "a2");
    await rejects(r.economy.v2.draw(ALICE, "a3"), 429);
  });

  it("can be switched off", async () => {
    const r = await rig(cfg({ draw_price: 0 }));
    await fund(r, ALICE, 100);
    await rejects(r.economy.v2.draw(ALICE, "k"), 400);
  });

  it("guarantees an SR or better after draw_pity draws without one", async () => {
    const r = await rig(cfg({ draw_pity: 3 }));
    await fund(r, ALICE, 500);
    dice(r, 0, 0); // always the most common
    const rolls = [];
    for (let i = 0; i < 4; i++) {
      rolls.push(await r.economy.v2.draw(ALICE, `k${i}`));
      r.clock.at += 1000; // draws are told apart by when they happened
    }
    expect(rolls.map((x) => [x.item.rarity, x.by_pity])).toEqual([
      ["N", false],
      ["N", false],
      ["SR", true],
      ["N", false],
    ]);
    const album = await r.economy.v2.album(ALICE);
    expect(album.pity).toBe(3);
    expect(album.since_best).toBe(1);
  });

  it("has no pity when draw_pity is 0", async () => {
    const r = await rig(cfg({ draw_pity: 0 }));
    await fund(r, ALICE, 2000);
    dice(r, 0, 0);
    for (let i = 0; i < 40; i++) {
      expect((await r.economy.v2.draw(ALICE, `k${i}`)).item.rarity).toBe("N");
      r.clock.at += DAY;
    }
  });

  it("gives the coins back when the item cannot be written, and the key then says so", async () => {
    const r = await rig(cfg());
    await fund(r, ALICE, 100);
    const create = r.docs.create.bind(r.docs);
    r.docs.create = async () => {
      throw new Error("disk full");
    };
    await expect(r.economy.v2.draw(ALICE, "k")).rejects.toThrow("disk full");
    expect(await balance(r, ALICE)).toBe(100);
    r.docs.create = create;
    // The same key must not hand out an item for a charge that was given back.
    await rejects(r.economy.v2.draw(ALICE, "k"), 409);
    expect((await r.economy.v2.album(ALICE)).series[0]?.owned_distinct).toBe(0);
    await r.economy.v2.draw(ALICE, "k2");
    expect(await balance(r, ALICE)).toBe(70);
  });

  it("finishes a draw whose charge was written but whose item was not", async () => {
    const r = await rig(cfg());
    await fund(r, ALICE, 100);
    dice(r, 0, 0);
    // The first write is lost (a crash right after the charge) and nothing is given back.
    const create = r.docs.create.bind(r.docs);
    let lost = true;
    r.docs.create = async (d) => {
      if (lost) {
        lost = false;
        return false;
      }
      return create(d);
    };
    await r.economy.v2.draw(ALICE, "k");
    expect((await r.economy.v2.album(ALICE)).series[0]?.owned_distinct).toBe(0);
    // The retry restores the item without charging again.
    expect(await r.economy.v2.draw(ALICE, "k")).toMatchObject({ duplicate: true });
    expect(await balance(r, ALICE)).toBe(70);
    expect((await r.economy.v2.album(ALICE)).series[0]?.owned_distinct).toBe(1);
  });
});

describe("the album", () => {
  it("is empty for a stranger, and a series is complete when every item is owned", async () => {
    const r = await rig(cfg());
    expect((await r.economy.v2.album(DAVE)).member).toBe(false);
    expect((await r.economy.v2.album(CAROL)).member).toBe(false);
    await fund(r, ALICE, 500);
    for (const [i, die] of [0, 0.75, 0.95, 0.999].entries()) {
      dice(r, die, 0);
      await r.economy.v2.draw(ALICE, `k${i}`);
      r.clock.at += DAY; // a new day: draws_per_day does not get in the way
    }
    const album = await r.economy.v2.album(ALICE);
    expect(album.series[0]).toMatchObject({ owned_distinct: 4, total: 4, complete: true });
    expect(album.series[1]).toMatchObject({ owned_distinct: 0, complete: false });
  });

  it("counts every account of one person together", async () => {
    const r = await rig(cfg());
    await fund(r, ALICE, 100);
    dice(r, 0, 0);
    await r.economy.v2.draw(ALICE, "k");
    expect((await r.economy.v2.album(ALICE_TWO)).series[0]?.owned_distinct).toBe(1);
  });
});

describe("the traits of a portrait card", () => {
  it("fill the album once per card, and are not for giving away", async () => {
    const r = await rig(cfg());
    expect(await r.economy.v2.recordCard(ALICE, "c1", ["a_n", "a_sr", "not_a_trait", "a_n"])).toBe(
      2,
    );
    expect(await r.economy.v2.recordCard(ALICE, "c1", ["a_n", "a_sr"])).toBe(0);
    // A second card with the same trait gives a spare, which is still a card's and stays.
    expect(await r.economy.v2.recordCard(ALICE, "c2", ["a_n"])).toBe(0);
    const album = await r.economy.v2.album(ALICE);
    expect(album.series[0]?.items.find((i) => i.id === "a_n")?.owned).toBe(2);
    await rejects(r.economy.v2.giveItem(ALICE, BOB, "a_n", "g1"), 409, /不能送人/);
    expect(await r.economy.v2.recordCard(DAVE, "c3", ["a_n"])).toBe(0);
    expect(await r.economy.v2.recordCard(CAROL, "c4", ["a_n"])).toBe(0);
  });
});

describe("giving", () => {
  async function twoCopies(r: Rig, die = 0) {
    await fund(r, ALICE, 500);
    dice(r, die, 0);
    await r.economy.v2.draw(ALICE, "d1");
    await r.economy.v2.draw(ALICE, "d2");
  }

  it("moves a spare copy, by id or by name, once per key", async () => {
    const r = await rig(cfg());
    await twoCopies(r);
    const gift = await r.economy.v2.giveItem(ALICE, BOB, "甲N", "g1");
    expect(gift).toMatchObject({ item: "a_n", label: "甲N", to: "Bob", duplicate: false });
    expect(await r.economy.v2.giveItem(ALICE, BOB, "a_n", "g1")).toMatchObject({ duplicate: true });
    const mine = await r.economy.v2.album(ALICE);
    const bobs = await r.economy.v2.album(BOB);
    expect(mine.series[0]?.items[0]?.owned).toBe(1);
    expect(bobs.series[0]?.items[0]?.owned).toBe(1);
    // The last copy stays, and what was given cannot be passed on.
    await rejects(r.economy.v2.giveItem(ALICE, BOB, "a_n", "g2"), 409, /重複/);
    await rejects(r.economy.v2.giveItem(BOB, ALICE, "a_n", "g3"), 409);
    await rejects(r.economy.v2.giveItem(ALICE, BOB, "nothing", "g4"), 400);
    await rejects(r.economy.v2.giveItem(ALICE, BOB, "a_r", "g5"), 409);
  });

  it("is refused to oneself, to strangers and to the blocked in the same words as a transfer", async () => {
    const r = await rig(cfg());
    await twoCopies(r);
    await rejects(r.economy.v2.giveItem(ALICE, ALICE_TWO, "a_n", "g1"), 400);
    await rejects(r.economy.v2.giveItem(ALICE, DAVE, "a_n", "g2"), 403, "對方現在收不到");
    await rejects(r.economy.v2.giveItem(ALICE, CAROL, "a_n", "g3"), 403, "對方現在收不到");
    await rejects(r.economy.v2.giveItem(DAVE, BOB, "a_n", "g4"), 403);
  });

  it("holds to item_gifts_per_day for the sender and for the receiver", async () => {
    const r = await rig(cfg({ item_gifts_per_day: 1, draw_pity: 0 }));
    for (const who of [ALICE, BOB, ERIN]) {
      await fund(r, who, 1000);
      dice(r, 0, 0);
      for (let i = 0; i < 3; i++) await r.economy.v2.draw(who, `${who.id}${i}`);
    }
    await r.economy.v2.giveItem(ALICE, BOB, "a_n", "g1");
    await rejects(r.economy.v2.giveItem(ALICE, ERIN, "a_n", "g2"), 429, /最多送 1 個/);
    // Bob already received one today: nobody else can send him another, in the usual words.
    await rejects(r.economy.v2.giveItem(ERIN, BOB, "a_n", "g3"), 403, "對方現在收不到");
    r.clock.at += DAY;
    await r.economy.v2.giveItem(ERIN, BOB, "a_n", "g4");
  });

  it("can be closed", async () => {
    const r = await rig(cfg({ item_gifts_per_day: 0 }));
    await twoCopies(r);
    await rejects(r.economy.v2.giveItem(ALICE, BOB, "a_n", "g"), 400);
  });
});

describe("tools and commands", () => {
  it("check_collection speaks the odds and the speaker's own album; draw_collectible draws in text only", async () => {
    const r = await rig(cfg());
    await fund(r, ALICE, 100);
    const caps = v2Capabilities(r.economy);
    const look = await say(r, caps, "check_collection", ALICE, "m1");
    expect(look.text).toContain("甲系列 0/4");
    expect(look.text).toContain("N 70%");
    expect(look.text).toContain("稱號:還沒有");
    dice(r, 0, 0);
    const drew = await say(r, caps, "draw_collectible", ALICE, "m2");
    expect(drew.data).toMatchObject({ done: true, item: "甲N", rarity: "N", charged: 30 });
    // The same message is the same draw.
    await say(r, caps, "draw_collectible", ALICE, "m2");
    expect(await balance(r, ALICE)).toBe(70);
    const voice = { ...TEXT, kind: "voice" } as const;
    const refused = await say(r, caps, "draw_collectible", ALICE, "m3", {}, false, voice);
    expect(refused.data).toMatchObject({ accepted: false, reason: "unconfirmed" });
    expect(await balance(r, ALICE)).toBe(70);
    // Bob's album is his own.
    expect((await say(r, caps, "check_collection", BOB, "m4")).text).toContain("甲系列 0/4");
  });

  it("/me draw, /me album, /me giveitem and /me titles answer with neutral cards", async () => {
    const r = await rig(cfg());
    await fund(r, ALICE, 500);
    dice(r, 0, 0);
    const registry = new CommandRegistry(
      Permissions.fromStrings(["discord:1", "discord:2", "discord:4"]),
    );
    const services = new ServiceRegistry();
    services.provide("test", Economy2Key, r.economy.v2);
    new EconomyCommands().install(registry, services);
    const run = (
      path: string[],
      who: AccountRef,
      args: Record<string, string | number | boolean> = {},
    ) =>
      registry.dispatch({
        path,
        args,
        invoker: who,
        invoker_display_name: "x",
        context: { platform: "discord", scope: null, channel: "9", kind: "dm" },
        invoker_is_guild_admin: false,
      });
    const drawn = await run(["me", "draw"], ALICE);
    expect(drawn.card?.accent).toBe("neutral");
    expect(drawn.text).toContain("甲N");
    expect(drawn.text).toContain("新的一個");
    expect((await run(["me", "draw"], ALICE)).text).toContain("重複的");
    const album = await run(["me", "album"], ALICE);
    expect(album.text).toContain("甲N×2");
    expect(album.text).toContain("？？？");
    expect(album.text).toContain("N 70%");
    const given = await run(["me", "giveitem"], ALICE, { user: "2", item: "甲N" });
    expect(given.text).toContain("把「甲N」送給了");
    expect((await run(["me", "giveitem"], ALICE, { user: "2", item: "甲N" })).tone).toBe("info");
    expect((await run(["me", "album"], DAVE)).tone).toBe("info");
    expect((await run(["me", "draw"], DAVE)).tone).toBe("info");
    const titles = await run(["me", "titles"], ALICE);
    expect(titles.card?.accent).toBe("neutral");
  });
  it("tells people to type the path that exists where they are", async () => {
    const r = await rig(cfg());
    await r.economy.v2.openPrediction({ question: "q", options: ["a", "b"], minutes: 30 });
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "web:1"]));
    const services = new ServiceRegistry();
    services.provide("test", Economy2Key, r.economy.v2);
    new EconomyCommands().install(registry, services);
    const ask = (platform: "discord" | "web") =>
      registry.dispatch({
        path: ["me", "predictions"],
        args: {},
        invoker: { platform, id: "1" },
        invoker_display_name: "x",
        context: { platform, scope: null, channel: "9", kind: "dm" },
        invoker_is_guild_admin: false,
      });
    await fund(r, ALICE, 10);
    expect(JSON.stringify((await ask("discord")).card)).toContain("/me play bet");
    expect(JSON.stringify((await ask("web")).card)).toContain("/me bet");
    expect(JSON.stringify((await ask("web")).card)).not.toContain("/me play");
  });
});
