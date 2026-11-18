// Phase 4 step 4 on the heart's side: evidence (time together in voice, songs heard, what the
// economy reports), the economy's small effects on `heart_person` with cause `evidence` under the
// caps, and what the nightly reflection on one person reads and writes (who did anything in a
// span, their day, a reflection applied whole or not at all).

import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  Events,
  HeartKey,
  RelationshipEffectsKey,
  SocialSignalsKey,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  HeartEffects,
  HeartModule,
  HeartService,
  heartTables,
  MIN_TOGETHER_MS,
  Together,
  togetherOf,
} from "../src/index.js";

/** 2026-11-17 10:00 in her time zone (UTC+8). */
const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const MIN = 60_000;
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };

class ManualClock implements Clock {
  constructor(public at = T0) {}
  now(): number {
    return this.at;
  }
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function openStore(clock: Clock): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:", { plugins: [heartTables], clock });
  cleanup.push(() => store.close());
  return store;
}

const account = (id: string): AccountRef => ({ platform: "discord", id });
const member = (id: string, is_self = false): VoiceParticipant =>
  ({ account: account(id), display_name: id, is_self }) as VoiceParticipant;

describe("Together", () => {
  it("ends a stay when they leave or she does, in whole minutes, nothing under a minute", () => {
    const ended: { id: string; minutes: number }[] = [];
    const t = new Together((s) => ended.push({ id: s.account.id, minutes: s.minutes }));
    t.joined(VOICE, [member("me", true), member("amy"), member("bob")], T0);
    t.participants(VOICE, [member("me", true), member("amy"), member("cat")], T0 + 20 * MIN);
    // Bob left after 20 minutes; Cat came.
    expect(ended).toEqual([{ id: "bob", minutes: 20 }]);
    t.left(VOICE, T0 + 20 * MIN + MIN_TOGETHER_MS - 1);
    // Amy stayed 20 minutes and a bit; Cat less than a minute.
    expect(ended).toEqual([
      { id: "bob", minutes: 20 },
      { id: "amy", minutes: 21 },
    ]);
  });

  it("follows her when she is moved to another channel", () => {
    const ended: { id: string; channel: string; minutes: number }[] = [];
    const t = new Together((s) =>
      ended.push({ id: s.account.id, channel: s.context.channel, minutes: s.minutes }),
    );
    const other = { ...VOICE, channel: "other" };
    t.joined(VOICE, [member("amy")], T0);
    // Moved: the list of another channel is the one she is in now.
    t.participants(other, [member("amy"), member("bob")], T0 + 10 * MIN);
    expect(ended).toEqual([{ id: "amy", channel: "v", minutes: 10 }]);
    t.left(other, T0 + 25 * MIN);
    expect(ended).toEqual([
      { id: "amy", channel: "v", minutes: 10 },
      { id: "amy", channel: "other", minutes: 15 },
      { id: "bob", channel: "other", minutes: 15 },
    ]);
  });

  it("knows who heard a song to the end: there at the start and still there", () => {
    const t = new Together(() => {});
    t.joined(VOICE, [member("amy"), member("bob")], T0);
    t.songStarted("小幸運");
    t.participants(VOICE, [member("amy"), member("cat")], T0 + MIN);
    expect(t.songEnded(true, "", T0 + 4 * MIN).map((h) => [h.account.id, h.title])).toEqual([
      ["amy", "小幸運"],
    ]);
    t.songStarted("another");
    expect(t.songEnded(false, "", T0 + 5 * MIN)).toEqual([]);
  });
});

describe("evidence through the heart's service", () => {
  it("writes evidence for voice and songs, for people the accounts belong to", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock);
    const known: Record<string, string> = { amy: "p-amy" };
    const together = togetherOf((a) => known[a.id] ?? null, heart);
    const env = (type: string, data: unknown) => ({ type, v: 1, data }) as never;
    together.on(
      env(Events.VoiceJoined.type, {
        context: VOICE,
        participants: [member("amy"), member("zed")],
      }),
      T0,
    );
    together.on(
      env(Events.SingCue.type, { state: "started", song: "s1", title: "晴天" }),
      T0 + MIN,
    );
    together.on(
      env(Events.SingCue.type, { state: "ended", song: "s1", outcome: "finished" }),
      T0 + 5 * MIN,
    );
    together.on(env(Events.VoiceLeft.type, { context: VOICE }), T0 + 30 * MIN);
    const evidence = people.log.evidence("p-amy", toTimestamp(T0), toTimestamp(T0 + 60 * MIN));
    expect(evidence.map((e) => [e.evidence.kind, e.evidence.weight, e.evidence.detail])).toEqual([
      ["heard_song", null, "聽你唱完了〈晴天〉"],
      ["voice_together", 30, "在你的語音頻道一起待了 30 分鐘"],
    ]);
    // Someone she does not know is left out.
    expect(store.events?.query({ types: ["heart.evidence"], limit: 100 }).length).toBe(2);
  });

  it("gives someone without a row one, so the nightly pass sees them; never a bot", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock, { isBot: (p) => p === "p-bot" });
    for (const person of ["p-quiet", "p-bot"]) {
      heart.evidence({ person, kind: "voice_together", detail: "一起待了 30 分鐘", weight: 30 });
    }
    expect(people.has("p-quiet")).toBe(true);
    expect(people.has("p-bot")).toBe(false);
    expect(people.active(T0 - MIN, T0 + MIN, 10).map((a) => a.person)).toEqual(["p-quiet"]);
    const all = store.events?.query({ types: ["heart.evidence"], limit: 10 }) ?? [];
    expect(all.map((e) => e.envelope.person_id)).toEqual(["p-quiet"]);
  });

  it("never records evidence about someone blocked", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock);
    heart.evidence({ person: "amy", kind: "gift", detail: "送了你餅乾", weight: 10 });
    people.adminSet("bob", "bond", 1);
    people.upsert({ ...(people.get("bob") ?? fail()), tags: ["blocked"] });
    heart.evidence({ person: "bob", kind: "gift", detail: "送了你餅乾", weight: 10 });
    const all = store.events?.query({ types: ["heart.evidence"], limit: 10 }) ?? [];
    expect(all.map((e) => e.envelope.person_id)).toEqual(["amy"]);
  });
});

describe("the economy's effects", () => {
  it("adds a damped hair per gift up to the gift's own cap, cause evidence", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const effects = new HeartEffects(people);
    const gift = {
      kind: "treat" as const,
      affinity: 0.4,
      trust: 0.1,
      kind_cap: { affinity: 0.7, trust: 0.5 },
    };
    const first = await effects.gain("amy", gift, T0);
    expect(first.affinity).toBeCloseTo(0.4);
    expect(first.trust).toBeCloseTo(0.1);
    const second = await effects.gain("amy", gift, T0 + 1);
    expect(second.affinity).toBeCloseTo(0.3);
    // The gift cap (0.7) is reached.
    expect((await effects.gain("amy", gift, T0 + 2)).affinity).toBe(0);
    const changes = people.log.history("amy");
    expect(new Set(changes.map((c) => c.change.cause))).toEqual(new Set(["evidence"]));
  });
});

describe("the nightly reflection on one person", () => {
  it("lists who did anything in the span, most first, never someone blocked", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock);
    const up = { field: "warmth" as const, direction: "up" as const, quote: "好可愛" };
    heart.seen("amy", { text: "早安米優", directed: true, together: false, at: T0 });
    heart.feel("bob", [up, { ...up, field: "trust" }], { turn: "t1" });
    heart.evidence({ person: "bob", kind: "gift", detail: "送了你餅乾", weight: 5 });
    heart.seen("cat", { text: "早安", directed: false, together: false, at: T0 });
    heart.feel("dan", [up], { turn: "t2" });
    people.upsert({ ...(people.get("dan") ?? fail()), tags: ["blocked"] });
    const active = heart.active(T0 - MIN, T0 + MIN, 10);
    expect(active.map((a) => a.person)).toEqual(["bob", "amy"]);
    expect(active[0]).toMatchObject({ changes: 2, evidence: 1 });
    expect(heart.active(T0 - MIN, T0 + MIN, 1).map((a) => a.person)).toEqual(["bob"]);
  });

  it("gives the day of one person, and the tier the bond is held under", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock);
    people.adminSet("amy", "bond", 119.5);
    heart.feel("amy", [{ field: "bond", direction: "up", quote: "一起熬夜" }], { turn: "t" });
    heart.evidence({
      person: "amy",
      kind: "heard_song",
      detail: "聽你唱完了〈晴天〉",
      weight: null,
    });
    const day = heart.day("amy", T0 - MIN, T0 + MIN);
    expect(day?.changes.map((c) => [c.cause, c.quote])).toEqual([
      ["admin", ""],
      ["feel", "一起熬夜"],
    ]);
    expect(day?.evidence.map((e) => e.kind)).toEqual(["heard_song"]);
    // 知心 (120) needs an anchor: the rise stopped half a point under it.
    expect(day?.record.bond).toBe(119.5);
    expect(day?.held).toEqual({ tier: 120, label: "知心" });
    expect(heart.day("nobody", T0, T0 + 1)).toBeNull();
  });

  it("applies a reflection whole: anchor, texts, corrections with cause reflect", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock);
    people.adminSet("amy", "bond", 119.5);
    const done = heart.reflect("amy", {
      texts: { stance: "嘴上嫌他,其實很黏他", jokes: "熬夜冠軍" },
      public_feeling: "哼,今天也算陪我陪得不錯啦。",
      proposals: [
        { field: "bond", direction: "up", quote: "一起熬夜唱完整張專輯" },
        { field: "grudge", direction: "down", quote: "他道歉了" },
      ],
      anchor: { tier: 120, note_ref: "line-1", quote: "一起熬夜唱完整張專輯" },
    });
    expect(done).toMatchObject({ changes: 2, anchored: true, public_feeling: true });
    const row = people.get("amy") ?? fail();
    expect(row.stance).toBe("嘴上嫌他,其實很黏他");
    expect(row.impression).toBe("");
    expect(row.public_feeling).toBe("哼,今天也算陪我陪得不錯啦。");
    // Anchored first, so the rise passes 知心.
    expect(row.bond).toBeGreaterThan(120);
    expect(row.anchors.map((a) => [a.tier, a.by, a.note_ref])).toEqual([
      [120, "reflect", "line-1"],
    ]);
    const causes = people.log.history("amy", { limit: 2 }).map((h) => h.change.cause);
    expect(causes).toEqual(["reflect", "reflect"]);
  });

  it("changes nothing when it cannot be applied whole", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock);
    people.adminSet("amy", "bond", 30);
    const before = people.get("amy");
    expect(() =>
      heart.reflect("amy", {
        texts: { stance: "新的" },
        proposals: [{ field: "bond", direction: "up", quote: "x" }],
        // 朋友 takes no anchor.
        anchor: { tier: 15, note_ref: "n", quote: "q" },
      }),
    ).toThrow();
    expect(people.get("amy")).toEqual(before);
    expect(() => heart.reflect("nobody", { texts: {}, proposals: [], anchor: null })).toThrow();
  });
});

describe("module heart", () => {
  it("provides the economy's effects and writes the voice evidence it hears", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    sup.services.provide("app", StoreKey, store);
    await sup.register(new HeartModule("p", { clock }), null, true);
    await sup.startAll();
    expect(sup.services.get(RelationshipEffectsKey)).toBeInstanceOf(HeartEffects);
    expect(sup.services.require(HeartKey).evidence).toBeTypeOf("function");
    sup.bus.publish("voice", Events.VoiceJoined, {
      context: VOICE,
      participants: [member("amy")],
    } as never);
    // The module reads the bus in a task of its own: let it take the join at T0.
    await new Promise((r) => setTimeout(r, 20));
    clock.at += 12 * MIN;
    sup.bus.publish("voice", Events.VoiceLeft, { context: VOICE } as never);
    // Amy was never seen in chat: her account is made a person when she is in the channel.
    const evidence = () => store.events?.query({ types: ["heart.evidence"], limit: 10 }) ?? [];
    await waitFor(() => evidence().length > 0);
    const amy = await store.people.personByAccount(account("amy"));
    expect(evidence()[0]?.envelope.person_id).toBe(amy?.id);
    expect(evidence()[0]?.envelope.data).toMatchObject({ kind: "voice_together", weight: 12 });
    // She has a row now, and is who the bus's account is to everyone else (`SocialSignalsKey`).
    expect(sup.services.require(SocialSignalsKey).attitude(account("amy"))?.person).toBe(amy?.id);
  });

  it("writes nothing about a bot in her voice channel", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    sup.services.provide("app", StoreKey, store);
    await sup.register(new HeartModule("p", { clock }), null, true);
    await sup.startAll();
    sup.bus.publish("discord", Events.PlatformVoiceState, {
      platform: "discord",
      guild: "g",
      account: account("music"),
      display_name: "Music Bot",
      is_bot: true,
      channel: "v",
    } as never);
    sup.bus.publish("voice", Events.VoiceJoined, {
      context: VOICE,
      participants: [member("music"), member("amy")],
    } as never);
    await new Promise((r) => setTimeout(r, 20));
    clock.at += 12 * MIN;
    sup.bus.publish("voice", Events.VoiceLeft, { context: VOICE } as never);
    const evidence = () => store.events?.query({ types: ["heart.evidence"], limit: 10 }) ?? [];
    await waitFor(() => evidence().length > 0);
    await new Promise((r) => setTimeout(r, 20));
    const amy = await store.people.personByAccount(account("amy"));
    expect(evidence().map((e) => e.envelope.person_id)).toEqual([amy?.id]);
    expect(await store.people.personByAccount(account("music"))).toBeNull();
    expect(store.plugin(heartTables).people.list().total).toBe(1);
  });
});

async function waitFor(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error("timed out");
}

function fail(): never {
  throw new Error("no row");
}
