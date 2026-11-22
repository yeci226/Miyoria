// Cards she drops in a channel (v5-play §6.2): when a channel is lively enough, the limits per
// channel (a day, the gap, the delay, opting in), a drop that never reached the channel, and
// picking one up: the first one gets it, one a day, not twice in a row, free and with a part only
// a drop gives.

import { placeFields } from "@miyoria/runtime/kernel";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { ContextKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CardService,
  CardStore,
  type CardsConfig,
  CardsConfigSchema,
  cardsConfig,
  cardsSchema,
  DropWatch,
  drawCard,
  drawRules,
  SEED_PARTS,
  seededRandom,
  withDropPart,
} from "../src/index.js";

/** 2026-11-17 10:00 in her time zone (UTC+8). */
const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const MIN = 60_000;
const HERE: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const ELSEWHERE: ContextKey = { ...HERE, channel: "c2" };
const FACE = {
  name: "小明",
  avatar_url: null,
  call_name: null,
  line: null,
  stamp: null,
  fields: [],
  number: 1,
};
const FRIEND = {
  tier: "朋友",
  tier_label: "朋友 I",
  closeness: "不錯",
  trust: "有點信任",
  familiarity: "見過幾次",
  public_feeling: null,
};

let t: TestDb;
let store: CardStore;
let now: number;

beforeEach(() => {
  now = T0;
  t = openTestDb({ identity: true, plugins: [cardsSchema], clock: { now: () => now } });
  store = new CardStore(t.db, t.events);
});

afterEach(() => t.close());

const ON: Partial<CardsConfig> = { drops: true, drop_channels: ["c1"], drop_chance: 1 };

/** A watch whose delays run when asked and whose posts are recorded. */
function watch(config: Partial<CardsConfig> = ON, rolls: number[] = []) {
  const posted: { context: ContextKey; id: string }[] = [];
  const later: { ms: number; run: () => Promise<void> }[] = [];
  const reach = { ok: true };
  const w = new DropWatch({
    config: cardsConfig(config),
    store,
    random: () => rolls.shift() ?? 0,
    later: (ms, run) => later.push({ ms, run }),
    post: async (context, id) => {
      if (reach.ok) posted.push({ context, id });
      return reach.ok;
    },
    now: () => now,
  });
  /** `lines` lines from `people` people, a second apart, ending now. */
  const chatter = (lines: number, people: number, context = HERE) => {
    for (let i = 0; i < lines; i++) {
      w.heard({ context, who: `discord:u${i % people}`, at: now - (lines - i) * 1000 });
    }
  };
  const fire = async () => {
    for (const job of later.splice(0)) await job.run();
  };
  return { w, posted, later, reach, chatter, fire };
}

describe("a channel", () => {
  it("gets a drop once three people said twenty lines within ten minutes, after a delay", async () => {
    const few = watch();
    few.chatter(19, 3);
    expect(few.later).toEqual([]);
    const two = watch();
    two.chatter(30, 2);
    expect(two.later).toEqual([]);
    // Lines older than the window do not count.
    const slow = watch();
    for (let i = 0; i < 20; i++) {
      slow.w.heard({ context: HERE, who: `u${i % 3}`, at: now + i * MIN });
    }
    expect(slow.later).toEqual([]);
    const { posted, later, chatter, fire } = watch(ON, [0, 0.5]);
    chatter(20, 3);
    // Between 30 and 180 seconds: the second roll picks the middle.
    expect(later.map((l) => l.ms)).toEqual([105_000]);
    await fire();
    expect(posted.map((p) => p.context)).toEqual([HERE]);
    const drop = store.drop(posted[0]?.id ?? "");
    expect(drop).toMatchObject({ channel: "discord:g1:c1", claimed_by: null });
    expect(Date.parse(drop?.expires_at ?? "") - Date.parse(drop?.created_at ?? "")).toBe(10 * MIN);
  });

  it("only where it opted in, never in a DM, and not at all with drops off", () => {
    for (const [config, context] of [
      [{ ...ON, drops: false }, HERE],
      [ON, ELSEWHERE],
      [ON, { ...HERE, scope: null, kind: "dm" }],
    ] as const) {
      const { later, chatter } = watch(config);
      chatter(30, 5, context);
      expect(later).toEqual([]);
    }
  });

  it("rolls once a window, keeps a gap and at most two a day", async () => {
    // The first roll misses: no other roll until the window has passed.
    const { posted, chatter, fire, later } = watch({ ...ON, drop_chance: 0.5 }, [0.9]);
    chatter(25, 3);
    expect(later).toEqual([]);
    now += 5 * MIN;
    chatter(25, 3);
    expect(later).toEqual([]);
    now += 6 * MIN;
    chatter(25, 3);
    await fire();
    expect(posted).toHaveLength(1);
    // Within the gap of two hours: nothing.
    now += 60 * MIN;
    chatter(25, 3);
    expect(later).toEqual([]);
    now += 61 * MIN;
    chatter(25, 3);
    await fire();
    expect(posted).toHaveLength(2);
    // Two today already.
    now += 121 * MIN;
    chatter(25, 3);
    expect(later).toEqual([]);
  });

  it("forgets a drop that did not reach the channel", async () => {
    const { reach, chatter, fire, posted } = watch();
    reach.ok = false;
    chatter(20, 3);
    await fire();
    expect(posted).toEqual([]);
    expect(store.dropsSince("discord:g1:c1", 0)).toEqual({ count: 0, last: null });
  });
});

describe("a dropped card", () => {
  const face = async () => ({ face: FACE, relationship: FRIEND });
  let serials = 0;
  const service = (config: Partial<CardsConfig> = ON) =>
    new CardService(store, {
      config: cardsConfig(config),
      clock: { now: () => now },
      wallet: () => null,
      relationship: () => FRIEND,
      random: seededRandom(3),
      newSerial: () => `MYR-DROP-0000-${String(++serials).padStart(4, "0")}`,
    });
  const drop = (id: string, channel = "discord:g1:c1") =>
    store.addDrop(id, channel, now, now + 10 * MIN);

  it("goes to the first one, free, with a part only a drop gives", async () => {
    drop("d1");
    const cards = service();
    const [first, second] = await Promise.all([
      cards.claimDrop("p1", "d1", face),
      cards.claimDrop("p2", "d1", face),
    ]);
    if (!first?.ok) throw new Error("refused");
    expect(second).toEqual({ ok: false, reason: "drop_taken" });
    expect(first.issued.card).toMatchObject({ kind: "drop", price: 0, issue_key: "drop:d1" });
    expect(first.issued.card.parts.map((p) => p.id)).toContain("background.fireworks");
    expect(store.drop("d1")).toMatchObject({ claimed_by: "p1", serial: first.issued.card.serial });
    expect(store.pitySince("p1")).toBe(0);
    // Pressed again by whoever got it: the same card.
    const again = await cards.claimDrop("p1", "d1", face);
    expect(again.ok && again.issued).toMatchObject({ again: true, card: first.issued.card });
  });

  it("is one a day each, not two in a row in a channel, and gone once expired", async () => {
    const cards = service();
    drop("d1");
    expect((await cards.claimDrop("p1", "d1", face)).ok).toBe(true);
    drop("d2", "discord:g1:c9");
    expect(await cards.claimDrop("p1", "d2", face)).toEqual({ ok: false, reason: "drop_cap" });
    // The next day, the last one's taker is skipped in that channel, not elsewhere.
    now += 24 * 60 * MIN;
    drop("d3");
    expect(await cards.claimDrop("p1", "d3", face)).toEqual({ ok: false, reason: "drop_skipped" });
    expect((await cards.claimDrop("p2", "d3", face)).ok).toBe(true);
    drop("d4", "discord:g1:c9");
    expect((await cards.claimDrop("p1", "d4", face)).ok).toBe(true);
    drop("d5");
    now += 11 * MIN;
    expect(await cards.claimDrop("p3", "d5", face)).toEqual({ ok: false, reason: "drop_expired" });
    expect(await cards.claimDrop("p3", "nope", face)).toEqual({ ok: false, reason: "drop_gone" });
  });

  it("is put back when no card follows", async () => {
    const cards = service();
    drop("d1");
    expect(await cards.claimDrop("p1", "d1", async () => null)).toEqual({
      ok: false,
      reason: "no_face",
    });
    t.db.run("UPDATE cards_parts SET enabled = 0");
    await expect(cards.claimDrop("p2", "d1", face)).rejects.toThrow(/nothing to draw/);
    expect(store.drop("d1")).toMatchObject({ claimed_by: null, serial: null });
    t.db.run("UPDATE cards_parts SET enabled = 1");
    expect((await cards.claimDrop("p3", "d1", face)).ok).toBe(true);
  });

  it("forgets whoever picked it up, and still counts for the day and the channel", async () => {
    const cards = service();
    drop("d1");
    await cards.claimDrop("p1", "d1", face);
    expect(store.dropsSince("discord:g1:c1", T0).count).toBe(1);
    expect(store.forgetPerson(["p1"])).toMatchObject({ cards_card: 1, cards_drop: 1 });
    // Taken, by nobody named, and not theirs to take again.
    expect(store.drop("d1")).toMatchObject({ claimed_by: "", serial: null });
    expect(store.dropsSince("discord:g1:c1", T0).count).toBe(1);
    expect(await cards.claimDrop("p1", "d1", face)).toEqual({ ok: false, reason: "drop_taken" });
    // Their one drop of the day was had: asking to be forgotten gives them no second.
    drop("d2", "discord:g1:c9");
    expect(await cards.claimDrop("p1", "d2", face)).toEqual({ ok: false, reason: "drop_cap" });
    now += 24 * 60 * MIN;
    drop("d3", "discord:g1:c9");
    expect((await cards.claimDrop("p1", "d3", face)).ok).toBe(true);
  });
});

describe("withDropPart", () => {
  it("puts a drop-only part in its slot and takes the card's rarity from its rarest part", () => {
    const drawn = drawCard({
      catalogue: SEED_PARTS,
      rules: drawRules(cardsConfig()),
      since: 0,
      tier: "朋友",
      random: () => 0,
    });
    expect(drawn.rarity).toBe("N");
    const dropped = withDropPart(drawn, SEED_PARTS, () => 0);
    expect(dropped.parts.find((p) => p.slot === "background")?.id).toBe("background.fireworks");
    expect(dropped.parts.map((p) => p.slot)).toEqual(drawn.parts.map((p) => p.slot));
    expect(dropped.rarity).toBe("SR");
    const none = SEED_PARTS.filter((p) => !p.drop_only);
    expect(withDropPart(drawn, none, () => 0)).toBe(drawn);
  });
});

describe("drop settings per place", () => {
  it("are a list per server and a switch per channel; the rest is the cluster's", () => {
    const fields = placeFields(CardsConfigSchema).map((f) => [f.keys.join("."), f.scope]);
    expect(fields).toEqual(
      expect.arrayContaining([
        ["drops", "room"],
        ["drop_channels", "space"],
      ]),
    );
    expect(fields.map(([key]) => key)).not.toContain("drops_per_person_day");
  });

  it("drop in a channel its own server lists and turned on, nowhere else", async () => {
    const OTHER: ContextKey = { platform: "discord", scope: "g2", channel: "c1", kind: "channel" };
    const OFF_HERE: ContextKey = { ...HERE, channel: "c3" };
    const posted: ContextKey[] = [];
    const later: (() => Promise<void>)[] = [];
    const w = new DropWatch({
      config: cardsConfig(),
      // g1 lists c1 and c3 but c3 turned itself off; g2 lists only c9 (its c1 is not in it).
      at: (context) =>
        cardsConfig(
          context.scope === "g1"
            ? { ...ON, drop_channels: ["c1", "c3"], drops: context.channel !== "c3" }
            : { ...ON, drop_channels: ["c9"] },
        ),
      store,
      random: () => 0,
      later: (_ms, run) => later.push(run),
      post: async (context) => {
        posted.push(context);
        return true;
      },
      now: () => now,
    });
    expect([HERE, OFF_HERE, OTHER].map((c) => w.open(c))).toEqual([true, false, false]);
    for (const context of [HERE, OFF_HERE, OTHER]) {
      for (let i = 0; i < 25; i++) {
        w.heard({ context, who: `discord:u${i % 3}`, at: now - (25 - i) * 1000 });
      }
    }
    for (const run of later.splice(0)) await run();
    expect(posted).toEqual([HERE]);
  });
});
