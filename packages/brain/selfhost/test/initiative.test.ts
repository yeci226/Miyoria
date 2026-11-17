// Her own initiative on the new runner (B6): schedules, the inbox, opportunities through the
// gates, and what came of each run. A scripted model, the clock moved by hand (`Rig.shift`), the
// look (`Initiative.tick`) called by the test.

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { transcriptTables } from "@miyoria/memory/transcript";
import { sleep } from "@miyoria/runtime/kernel";
import { SqliteStore } from "@miyoria/store";
import {
  type AccountRef,
  type AffectState,
  AffectStateKey,
  type ArbiterDecision,
  ArbiterKey,
  type Attitude,
  type ContextKey,
  Events,
  HeartKey,
  type HeartPeople,
  type HeartView,
  type LedgerEntry,
  type PersonId,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { initiativeSettings, initiativeTables, type SelfHost } from "../src/index.js";
import {
  account,
  calls,
  channel,
  dm,
  line,
  mention,
  Rig,
  type RigOptions,
  says,
  stopRigs,
  textOf,
  until,
} from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const C2 = channel("c2");
const DM = dm("dm-owen");
const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * The shift that puts the clock at the next noon (UTC+8) at least three hours away: outside her
 * quiet hours, and five more hours stay within the same day of hers, at whatever hour this runs.
 */
function toNoon(): number {
  const now = Date.now();
  const day = 24 * HOUR;
  const local = now + 8 * HOUR;
  let noon = local - (local % day) + 12 * HOUR;
  while (noon - local < 3 * HOUR) noon += day;
  return noon - local;
}

const decisions = (rig: Rig) => rig.of<ArbiterDecision>(Events.ArbiterDecided.type);
const ledger = (rig: Rig) => rig.of<LedgerEntry>(Events.ArbiterLedger.type);

function host(rig: Rig): SelfHost {
  if (rig.host === null) throw new Error("no host");
  return rig.host;
}

async function store(): Promise<SqliteStore> {
  return SqliteStore.open(":memory:", { plugins: [transcriptTables, initiativeTables] });
}

function salient(context: ContextKey | null, detail: string, score = 0.8, key = "k1") {
  return {
    kind: "channel_active",
    key,
    account: null,
    person: null,
    display_name: null,
    context,
    detail,
    score,
    count: 1,
    first_at: toTimestamp(Date.parse("2026-11-17T06:00:00Z")),
    at: toTimestamp(Date.now()),
  } as never;
}

async function tick(rig: Rig): Promise<void> {
  await host(rig).initiative.tick();
  await sleep(20);
}

describe("schedule", () => {
  it("a time she set wakes her where she set it, after a restart", async () => {
    const db = await store();
    const first = await Rig.create({ store: db });
    first.model.push(
      calls("schedule", { when: "30m", note: "問 amy 蛋糕烤好了沒" }),
      says("好,我等等問"),
    );
    first.say(mention(C1, "amy", "@她 三十分鐘後提醒你問我蛋糕"));
    await until(() => first.sink.texts().length === 1, 3_000, "her answer");
    const result = first.model.requests[1]?.messages.find((m) => m.role === "tool");
    expect(String(result?.content)).toMatch(/設好了\(S[0-9A-Z]{5}\)/);
    await first.stop();

    const again = await Rig.create({ store: db });
    again.model.push(says("amy,蛋糕好了嗎?"));
    await tick(again);
    expect(again.model.requests).toHaveLength(0);
    again.shift = 31 * MIN;
    await tick(again);
    await until(() => again.sink.texts().length === 1, 3_000, "the timer's run");
    expect(again.sink.sent()).toEqual([["c1", "amy,蛋糕好了嗎?"]]);
    expect(textOf(again.model.requests[0])).toContain("你自己設的時間到了:「問 amy 蛋糕烤好了沒」");
    // Recorded: accepted, and her run as a ledger entry that waits for an answer.
    const timers = decisions(again).filter((d) => d.impulse.startsWith("timer:"));
    expect(timers.map((d) => [d.source, d.verdict])).toEqual([["agenda", "accepted"]]);
    await until(() => ledger(again).some((e) => e.outcome === "pending" && e.detail !== null));
    // It does not come back.
    again.shift = 40 * MIN;
    await tick(again);
    expect(again.model.requests).toHaveLength(1);
    await db.close();
  });

  it("a daily time wakes her each day; schedule_list shows it", async () => {
    const rig = await Rig.create();
    const book = host(rig).initiative.book;
    const when = book.when("daily 08:00");
    if (when === null) throw new Error("unreadable");
    book.set({ when, note: "早安巡一下頻道", context: C1 });
    expect(book.open()).toHaveLength(1);
    rig.shift = when.due - Date.now() + MIN;
    await tick(rig);
    await until(() => rig.model.requests.length === 1, 3_000, "the first day");
    rig.shift += 24 * HOUR;
    await tick(rig);
    await until(() => rig.model.requests.length === 2, 3_000, "the second day");
    for (const r of rig.model.requests) expect(textOf(r)).toContain("早安巡一下頻道");
    expect(book.open()).toHaveLength(1);
  });
});

describe("opportunities and gates", () => {
  it("a salient world event wakes her once; a weak one does not", async () => {
    const rig = await Rig.create();
    rig.model.push(says("哇,好熱鬧"));
    rig.sup.bus.publish("world", Events.WorldSalient, salient(C1, "大家在聊新遊戲", 0.3, "weak"));
    rig.sup.bus.publish("world", Events.WorldSalient, salient(C1, "頻道突然熱鬧起來"));
    await until(() => rig.sink.texts().length === 1, 3_000, "her run");
    expect(textOf(rig.model.requests[0])).toContain("剛發生一件事:「頻道突然熱鬧起來」");
    rig.sup.bus.publish("world", Events.WorldSalient, salient(C1, "頻道突然熱鬧起來"));
    rig.shift = 2 * HOUR;
    await tick(rig);
    await sleep(100);
    expect(rig.model.requests).toHaveLength(1);
  });

  it("a gate that stops one is recorded with its reason, once", async () => {
    let registry: ActuatorRegistry | null = null;
    const rig = await Rig.create({
      provide: (sup, tools) => {
        registry = new ActuatorRegistry({
          services: sup.services,
          tools,
          publish: sup.bus.publisher("actions"),
          builtins: false,
        });
        sup.services.provide("app", ActuatorRegistryKey, registry);
      },
    });
    await (registry as unknown as ActuatorRegistry).setPaused(true);
    rig.sup.bus.publish("world", Events.WorldSalient, salient(C1, "有人開台了"));
    await sleep(100);
    await tick(rig);
    expect(rig.model.requests).toHaveLength(0);
    const stopped = decisions(rig).filter(
      (d) => d.verdict === "rejected" && d.impulse.startsWith("world:"),
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ source: "world", reason: "paused" });
    expect(stopped[0]?.detail).toMatch(/^switch: /);
    // Resumed: it goes.
    await (registry as unknown as ActuatorRegistry).setPaused(false);
    rig.model.push(says("有人開台!"));
    await tick(rig);
    await until(() => rig.sink.texts().length === 1, 3_000, "her run");
  });

  it("she may stay quiet: a decision, recorded as such, and the item is seen", async () => {
    const rig = await Rig.create();
    const book = host(rig).initiative.book;
    book.set({ when: { due: Date.now() + MIN, daily: null }, note: "看看大家", context: C1 });
    rig.shift = 2 * MIN;
    await tick(rig); // the model gives nothing: she stays quiet
    await until(() => ledger(rig).some((e) => e.outcome === "ok"), 3_000, "her quiet run settled");
    const settled = ledger(rig).find((e) => e.outcome === "ok");
    expect(settled?.detail).toBe("她看過了,決定不說");
    expect(rig.sink.texts()).toEqual([]);
    expect(host(rig).initiative.gates.startsToday(Date.now() + rig.shift)).toBe(1);
    // Seen: the next run here does not show it again.
    rig.model.push(says("嗨"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    expect(textOf(rig.model.requests[1])).not.toContain("看看大家");
  });

  it("a run cut before its line settled is never woken again", async () => {
    const rig = await Rig.create();
    const book = host(rig).initiative.book;
    book.set({ when: { due: Date.now() + MIN, daily: null }, note: "講個冷笑話", context: C1 });
    rig.model.push({ events: says("你知道嗎"), delay: 400 });
    rig.shift = 2 * MIN;
    await tick(rig);
    await until(() => rig.model.requests.length === 1, 3_000, "her run");
    host(rig).halt();
    await until(
      () => ledger(rig).some((e) => e.outcome === "failed"),
      3_000,
      "the cut run settled",
    );
    rig.shift = 3 * HOUR;
    await tick(rig);
    await sleep(100);
    expect(rig.model.requests).toHaveLength(1);
    expect(decisions(rig).filter((d) => d.verdict === "accepted")).toHaveLength(1);
  });

  it("an inbox item of no place is shown in her next run anywhere, once", async () => {
    const rig = await Rig.create();
    rig.sup.bus.publish("world", Events.WorldSalient, salient(null, "Owen 在別的伺服器得獎了"));
    await sleep(100);
    // No home place: it cannot wake her, and says so.
    const world = decisions(rig).filter((d) => d.impulse.startsWith("world:"));
    expect(world.map((d) => d.reason)).toEqual(["nobody"]);
    rig.model.push(says("嗨"), says("再嗨"));
    rig.say(mention(C2, "amy", "@她 你好"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the first answer");
    const first = textOf(rig.model.requests[0]);
    expect(first).toContain("你的收件匣");
    expect(first).toContain("Owen 在別的伺服器得獎了");
    rig.say(mention(C2, "amy", "@她 還在嗎"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the second answer");
    expect(textOf(rig.model.requests[1])).not.toContain("Owen 在別的伺服器得獎了");
  });

  it("back-off: unanswered starts wait longer; an answer resets it", async () => {
    const rig = await Rig.create();
    const gates = host(rig).initiative.gates;
    const book = host(rig).initiative.book;
    const at = () => Date.now() + rig.shift;
    book.set({ when: { due: at() + MIN, daily: null }, note: "第一次", context: C1 });
    rig.model.push(says("有人在嗎"));
    rig.shift += 2 * MIN;
    await tick(rig);
    await until(() => rig.sink.texts().length === 1, 3_000, "the first start");
    await sleep(50);
    rig.shift += 11 * MIN;
    await tick(rig);
    const place = "test:guild:c1";
    expect(gates.misses(place, at())).toBe(1);
    expect(gates.gapMs(place, at())).toBe(20 * MIN);
    expect(ledger(rig).some((e) => e.outcome === "ignored")).toBe(true);
    // Someone answers her there: the gap is back to its base.
    rig.model.push(says("嗨嗨"));
    rig.say(mention(C1, "amy", "@她 我在"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the answer");
    expect(gates.misses(place, at())).toBe(0);
    expect(gates.gapMs(place, at())).toBe(10 * MIN);
  });
});

describe("her starts in the Arbiter's ledger", () => {
  it("a start of hers is an entry of ArbiterKey.ledger(), and settles there", async () => {
    const rig = await Rig.create({ arbiter: {} });
    const arbiter = rig.sup.services.get(ArbiterKey);
    if (arbiter === undefined) throw new Error("no arbiter");
    // A DM: someone is always there to hear her.
    rig.model.push(says("晚安"));
    rig.say(line(DM, "owen", "晚安"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the DM answer");
    await sleep(50);
    const book = host(rig).initiative.book;
    book.set({ when: { due: Date.now() + MIN, daily: null }, note: "問 owen 好了沒", context: DM });
    rig.model.push(says("owen,好了嗎"));
    rig.shift = 2 * MIN;
    await tick(rig);
    await until(() => rig.sink.texts().length === 2, 3_000, "her start");
    const mine = () => arbiter.ledger(DM).entries.filter((e) => e.summary.startsWith("timer:"));
    await until(() => mine().some((e) => e.outcome === "pending"), 3_000, "the entry waiting");
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ self_initiated: true, context: DM, kind: "turn" });
    // Someone answers: the same entry settles.
    rig.model.push(says("太好了"));
    rig.say(mention(DM, "owen", "好了"));
    await until(() => mine().some((e) => e.outcome === "ok"), 3_000, "the entry settled");
    expect(mine()).toHaveLength(1);
  });
});

describe("longing", () => {
  const owen = account("owen");

  async function rigWith(dmOk: boolean): Promise<Rig> {
    const options: RigOptions = {
      provide: (sup, tools) => {
        const registry = new ActuatorRegistry({
          services: sup.services,
          tools,
          publish: sup.bus.publisher("actions"),
          builtins: false,
        });
        void registry.privacy.set(owen, { dm: dmOk });
        sup.services.provide("app", ActuatorRegistryKey, registry);
        sup.services.provide("app", SocialSignalsKey, {
          attitude: (a: AccountRef) =>
            a.id === "owen" ? ({ person: "p-owen", blocked: false } as Attitude) : null,
        } as never);
        // The one she cares about most, missing them a lot (the heart's longing).
        withHeart({ person: "p-owen", cares: 0.8 }, 0.9)(sup);
      },
    };
    const rig = await Rig.create(options);
    // They talked in a DM once.
    rig.model.push(says("晚安"));
    rig.say(line(DM, "owen", "晚安"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the DM answer");
    await sleep(50);
    return rig;
  }

  it("leads to her DM with them, when they take DMs", async () => {
    const rig = await rigWith(true);
    rig.model.push(says("在幹嘛~"));
    rig.shift = toNoon();
    await tick(rig);
    await until(() => rig.sink.texts().length === 2, 3_000, "her DM");
    expect(rig.sink.sent().at(-1)).toEqual(["dm-owen", "在幹嘛~"]);
    expect(textOf(rig.model.requests[1])).toContain("你有點想念 歐歐");
    // Once a day.
    rig.shift += 5 * HOUR;
    await tick(rig);
    await sleep(100);
    expect(rig.model.requests).toHaveLength(2);
  });

  it("does not, when they opted out of DMs: consent, recorded", async () => {
    const rig = await rigWith(false);
    rig.shift = toNoon();
    await tick(rig);
    await sleep(100);
    expect(rig.model.requests).toHaveLength(1);
    const stopped = decisions(rig).find((d) => d.impulse.startsWith("longing:"));
    expect(stopped).toMatchObject({ verdict: "rejected", reason: "consent" });
  });

  /** The heart (docs/design/v5-heart.md H5): the one she cares about most, and their longing. */
  function withHeart(most: { person: PersonId; cares: number } | null, longing: number) {
    const heart: Pick<HeartPeople, "mostCared" | "view"> = {
      mostCared: () => most,
      view: (p) =>
        p === "p-owen"
          ? ({ person: p, longing, call_name: "歐歐", blocked: false } as HeartView)
          : null,
    };
    return (sup: Rig["sup"]) => sup.services.provide("app", HeartKey, heart as HeartPeople);
  }

  async function heartRig(
    most: { person: PersonId; cares: number } | null,
    longing: number,
    mood: { initiative: number; weight?: number } | null = null,
  ) {
    const rig = await Rig.create({
      ...(mood?.weight === undefined
        ? {}
        : { host: { initiative: { settings: initiativeSettings({ mood_weight: mood.weight }) } } }),
      provide: (sup, tools) => {
        if (mood !== null) {
          const affect: Pick<AffectState, "snapshot"> = {
            snapshot: () =>
              ({ biases: { talkativeness: 0, initiative: mood.initiative, wants: [] } }) as never,
          };
          sup.services.provide("app", AffectStateKey, affect as AffectState);
        }
        const registry = new ActuatorRegistry({
          services: sup.services,
          tools,
          publish: sup.bus.publisher("actions"),
          builtins: false,
        });
        void registry.privacy.set(owen, { dm: true });
        sup.services.provide("app", ActuatorRegistryKey, registry);
        sup.services.provide("app", SocialSignalsKey, {
          attitude: (a: AccountRef) =>
            a.id === "owen" ? ({ person: "p-owen", blocked: false } as Attitude) : null,
        } as never);
        withHeart(most, longing)(sup);
      },
    });
    rig.model.push(says("晚安"));
    rig.say(line(DM, "owen", "晚安"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the DM answer");
    await sleep(50);
    return rig;
  }

  it("with the heart: the one she cares about most, when the heart says she misses them", async () => {
    const rig = await heartRig({ person: "p-owen", cares: 0.6 }, 0.8);
    rig.model.push(says("在幹嘛~"));
    rig.shift = toNoon();
    await tick(rig);
    await until(() => rig.sink.texts().length === 2, 3_000, "her DM");
    expect(rig.sink.sent().at(-1)).toEqual(["dm-owen", "在幹嘛~"]);
    expect(textOf(rig.model.requests[1])).toContain("歐歐");
  });

  it("her wish to start things lowers how much she must miss them (mood_weight)", async () => {
    // Missed at 0.4, under longing_min (0.5): no DM by itself...
    const flat = await heartRig({ person: "p-owen", cares: 0.6 }, 0.4);
    flat.shift = toNoon();
    await tick(flat);
    await sleep(100);
    expect(flat.model.requests).toHaveLength(1);
    await flat.stop();
    // ...nor with mood_weight 0, however much she wants to start things...
    const off = await heartRig({ person: "p-owen", cares: 0.6 }, 0.4, { initiative: 1, weight: 0 });
    off.shift = toNoon();
    await tick(off);
    await sleep(100);
    expect(off.model.requests).toHaveLength(1);
    await off.stop();
    // ...but with the default weight and her wanting to start things, the bar is halved.
    const eager = await heartRig({ person: "p-owen", cares: 0.6 }, 0.4, { initiative: 1 });
    eager.model.push(says("在幹嘛~"));
    eager.shift = toNoon();
    await tick(eager);
    await until(() => eager.sink.texts().length === 2, 3_000, "her DM");
    expect(eager.sink.sent().at(-1)).toEqual(["dm-owen", "在幹嘛~"]);
  });

  it("with the heart: nobody she cares about, or not missed enough: no DM", async () => {
    for (const [most, longing] of [
      [null, 0.9],
      [{ person: "p-owen", cares: 0.6 }, 0.1],
    ] as const) {
      const rig = await heartRig(most, longing);
      rig.shift = toNoon();
      await tick(rig);
      await sleep(100);
      expect(rig.model.requests).toHaveLength(1);
      await rig.stop();
    }
  });
});
