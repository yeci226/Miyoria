// The rule triggers and the `emotion` prompt section, through the real module and bus.

import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type Attitude,
  type Clock,
  type ContextKey,
  customEvent,
  type Event,
  type JsonValue,
  PromptContributors,
  PromptContributorsKey,
  SelfStateKey,
  SocialSignalsKey,
  toTimestamp,
  type WorldSnapshot,
  type WorldState,
  WorldStateKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfModule, type SelfService } from "../src/index.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const text: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const voice: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const acc = (id: string): AccountRef => ({ platform: "discord", id });

class ManualClock implements Clock {
  constructor(public at = T0) {}
  now(): number {
    return this.at;
  }
}

/** People by account id `"1"` → person `"p1"`, with the affinities given. */
class FakeSocial {
  readonly affinity = new Map<string, number>([
    ["p1", 70],
    ["p2", 10],
    ["p3", 60],
  ]);
  attitude(account: AccountRef): Attitude | null {
    return this.attitudeOf(`p${account.id}`);
  }
  attitudeOf(person: string): Attitude | null {
    const a = this.affinity.get(person);
    if (a === undefined) return null;
    return {
      person,
      affinity: a,
      trust: 10,
      familiarity: 10,
      blocked: false,
      label: "朋友",
      call_name: null,
    };
  }
}

class FakeWorld implements WorldState {
  her: WorldSnapshot["her"] = {
    voice: null,
    voice_name: null,
    golive: null,
    streaming: false,
    scene: null,
    game: null,
  };
  members: string[] = [];
  snapshot(): WorldSnapshot {
    return {
      at: toTimestamp(T0),
      time: { local: "", weekday: 1, weekend: false, part_of_day: "", utc_offset_minutes: 480 },
      her: this.her,
      people: [],
      voice_channels: [
        {
          platform: "discord",
          guild: "g1",
          channel: "v1",
          name: "語音",
          members: this.members.map((id) => ({
            account: acc(id),
            display_name: id,
            is_self: false,
          })),
        } as unknown as WorldSnapshot["voice_channels"][number],
      ],
      channels: [],
    };
  }
  person() {
    return null;
  }
  personById() {
    return null;
  }
  summary() {
    return "";
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function boot(display: "open" | "tsundere" = "tsundere") {
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  const clock = new ManualClock();
  const contributors = new PromptContributors();
  const world = new FakeWorld();
  const social = new FakeSocial();
  sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
  sup.services.provide("app", PromptContributorsKey, contributors);
  sup.services.provide("app", WorldStateKey, world);
  sup.services.provide("app", SocialSignalsKey, social);
  const temperament = { display, emotions: { shy: { gain: 1.8 }, missing: { gain: 0.5 } } };
  await sup.register(new SelfModule("p", { clock, temperament }), null, true);
  await sup.startAll();
  const self = sup.services.require(SelfStateKey) as SelfService;
  const publish = (event: Event) => sup.bus.publish("test", event);
  return { sup, clock, contributors, world, social, self, publish };
}

type Booted = Awaited<ReturnType<typeof boot>>;

const socialEvent = (person: string, kind: string, extra: Record<string, JsonValue> = {}) =>
  customEvent("social.event", {
    person,
    name: `name-${person}`,
    kind,
    source: "rule",
    scale: 1,
    context: null,
    ...extra,
  });

function message(
  author: string,
  opts: { direct?: boolean; replyTo?: string; context?: ContextKey } = {},
): Event {
  const context = opts.context ?? text;
  return {
    type: "platform_message_created",
    data: {
      id: { context, id: `m${Math.random()}` },
      author: { account: acc(author), display_name: `name-p${author}`, is_bot: false },
      text: "…",
      mentions_self: opts.direct ?? false,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(T0),
      referenced:
        opts.replyTo === undefined
          ? null
          : { author: acc(opts.replyTo), author_name: opts.replyTo, text: "…" },
    },
  };
}

/** Gives `person` enough romance on past days to be her crush (now stays now). */
function makeCrush(h: Booted, person = "p1") {
  const now = h.clock.at;
  for (let d = 10; d > 0; d--) {
    h.clock.at = now - d * DAY;
    h.self.romance(person, 0.06);
  }
  h.clock.at = now;
  expect(h.self.crush()?.person).toBe(person);
}

/** Waits until every event published before is handled (the bus keeps order). */
async function settle(h: Booted) {
  const before = h.self.drives().curiosity;
  h.publish(customEvent("self.nudge", { curiosity: 0.1 }));
  await vi.waitFor(() => expect(h.self.drives().curiosity).toBeGreaterThan(before));
}

const value = (h: Booted, name: string) =>
  h.self.emotions(0).find((e) => e.name === name)?.intensity ?? 0;

describe("rule triggers", () => {
  it("gift: joy and gratitude; food the giver counted itself takes only what it says", async () => {
    const h = await boot();
    h.self.adjust({ hunger: 0.9 - h.self.drives().hunger }, "test");
    h.publish(socialEvent("p1", "gift", { source: "economy", scale: 0.36, hunger: 0 }));
    await vi.waitFor(() => expect(value(h, "gratitude")).toBeGreaterThan(0));
    expect(h.self.drives().hunger).toBeCloseTo(0.9, 5);
    h.publish(socialEvent("p2", "gift"));
    await vi.waitFor(() => expect(h.self.drives().hunger).toBeCloseTo(0.6, 5));
  });

  it("broken_promise: anger and resentment toward the person who did not pay", async () => {
    const h = await boot();
    h.publish(socialEvent("p2", "broken_promise", { source: "economy" }));
    await vi.waitFor(() =>
      expect(h.self.heart("p2")?.emotions.resentment ?? 0).toBeGreaterThan(0.3),
    );
    expect(value(h, "anger")).toBeGreaterThan(0.15);
    expect(h.self.heart("p1")?.emotions.resentment ?? 0).toBe(0);
  });

  it("praise: joy (medium) and, for a tsundere, a little shyness; attachment does not grow by itself", async () => {
    const h = await boot();
    h.publish(socialEvent("p1", "praise"));
    await vi.waitFor(() => expect(value(h, "joy")).toBeGreaterThan(0.15));
    // shy weak 0.1 × her gain 1.8.
    expect(value(h, "shy")).toBeGreaterThan(0.15);
    // Not pride: that is for her songs.
    expect(value(h, "pride")).toBeLessThan(0.2);
    // Attachment only moves on Reflect's proposal (a bond change), never from events.
    expect(h.self.heart("p1")?.romance ?? 0).toBe(0);
    // Esteem satisfied.
    expect(h.self.drives().esteem).toBeLessThan(0.3);
  });

  it("the same praise again within two hours counts for less (habituation)", async () => {
    const h = await boot();
    h.publish(socialEvent("p1", "praise"));
    await vi.waitFor(() => expect(value(h, "joy")).toBeGreaterThan(0.15));
    const first = value(h, "joy");
    h.publish(socialEvent("p1", "praise"));
    await vi.waitFor(() => expect(value(h, "joy")).toBeGreaterThan(first));
    const second = value(h, "joy") - first;
    // 0.2 × 0.8 of room first, then half of it.
    expect(second).toBeLessThan(first * 0.6);
  });

  it("insults are not capped but habituate: anger and 不爽 toward the person, never to the top", async () => {
    const h = await boot();
    for (let i = 0; i < 6; i++) h.publish(socialEvent("p2", "insult"));
    await vi.waitFor(() =>
      expect(h.self.heart("p2")?.emotions.resentment ?? 0).toBeGreaterThan(0.4),
    );
    expect(value(h, "anger")).toBeGreaterThan(0.3);
    // 0.35 × (1 + ½ + ¼ ...) at most, and the ten-minute budget holds.
    expect(value(h, "anger")).toBeLessThan(0.8);
    // Her own mind's hints are not counted twice.
    const before = value(h, "joy");
    h.publish(socialEvent("p1", "warm", { source: "mind" }));
    h.publish(socialEvent("p1", "apology"));
    await settle(h);
    expect(value(h, "joy")).toBe(before);
  });

  it("dying in a game: 不甘心 and 怒; an advancement: 得意", async () => {
    const h = await boot();
    h.publish(
      customEvent("game.minecraft.death", { type: "death", data: { text: "被苦力怕炸死" } }),
    );
    await vi.waitFor(() => expect(value(h, "frustration")).toBeGreaterThan(0.15));
    expect(value(h, "anger")).toBeGreaterThan(0.05);
    h.publish(customEvent("game.minecraft.event", { type: "advancement", data: {} }));
    await vi.waitFor(() => expect(value(h, "pride")).toBeGreaterThan(0.25));
  });

  it("a song finished: 得意, and praise right after is pride in the song; a song cut off: 哀 / 不甘心", async () => {
    const h = await boot();
    h.publish(customEvent("sing.cue", { state: "started", song: "s1", title: "t" }));
    h.publish(customEvent("sing.cue", { state: "ended", song: "s1", outcome: "finished" }));
    await vi.waitFor(() => expect(value(h, "pride")).toBeGreaterThan(0.18));
    const afterSong = value(h, "pride");
    h.publish(socialEvent("p3", "praise"));
    // Praise right after a song: the song applauded (medium).
    await vi.waitFor(() => expect(value(h, "pride")).toBeGreaterThan(afterSong + 0.1));
    expect(h.self.emotions(0).find((e) => e.name === "pride")?.cause).toContain("歌");

    // (Everything stirred in the last ten minutes counts against the budget: let it pass.)
    h.clock.at += 11 * MINUTE;
    h.publish(customEvent("sing.cue", { state: "ended", song: "s2", outcome: "interrupted" }));
    await vi.waitFor(() => expect(value(h, "sorrow")).toBeGreaterThan(0.08));
    expect(value(h, "frustration")).toBeGreaterThan(0.15);
  });

  it("promises kept and broken, from the appraisal", async () => {
    const h = await boot();
    h.publish(
      customEvent("social.appraisal", {
        context: { ...text },
        her: { joy: 0.4, love: 1 },
        people: [
          { person: "p1", name: "A", toward_her: 0.5, romance: 0, others: 0, promise: "kept" },
          { person: "p3", name: "C", toward_her: 0, romance: 0, others: 0, promise: "broken" },
        ],
      }),
    );
    await vi.waitFor(() =>
      expect(h.self.heart("p3")?.emotions.resentment ?? 0).toBeGreaterThan(0.15),
    );
    expect(h.self.heart("p1")?.emotions.gratitude ?? 0).toBeGreaterThan(0.15);
    expect(value(h, "sorrow")).toBeGreaterThan(0.05);
    // The appraisal's `joy: 0.4` is one medium appraisal, and the kept promise adds a weak one.
    expect(value(h, "joy")).toBeGreaterThan(0.2);
    expect(value(h, "joy")).toBeLessThan(0.5);
  });

  it("someone she likes keeps talking to others and ignores her: 嫉妒 (more for her crush)", async () => {
    const h = await boot();
    makeCrush(h);
    for (let i = 0; i < 3; i++) h.publish(message("1", { replyTo: "9" }));
    await vi.waitFor(() =>
      expect(h.self.heart("p1")?.emotions.jealousy ?? 0).toBeGreaterThan(0.15),
    );
    expect(value(h, "jealousy")).toBeGreaterThan(0.15);
    expect(h.self.drives().longing).toBeGreaterThan(0);
    // Someone she does not care about: no jealousy.
    for (let i = 0; i < 3; i++) h.publish(message("2", { replyTo: "9" }));
    await settle(h);
    expect(h.self.heart("p2")?.emotions.jealousy ?? 0).toBe(0);
  });

  it("someone she cares about away for days is missed; coming back turns it into joy", async () => {
    const h = await boot();
    h.publish(message("3", { direct: true }));
    await vi.waitFor(() => expect(h.self.heart("p3")?.last_seen).not.toBeNull());
    for (let hour = 1; hour <= 24 * 5; hour++) {
      h.clock.at = T0 + hour * HOUR;
      // Others keep her company meanwhile (no loneliness in the way).
      h.self.adjust({ social: -1, attention: -1, hunger: -1, esteem: -1 }, "test");
    }
    const missing = h.self.heart("p3")?.emotions.missing ?? 0;
    expect(missing).toBeGreaterThan(0.2);
    expect(h.self.shown()?.style).toContain("裝作不在意");

    h.publish(message("3", { direct: true }));
    await vi.waitFor(() => expect(h.self.heart("p3")?.emotions.missing ?? 0).toBeLessThan(missing));
    expect(h.self.emotions(0).find((e) => e.name === "joy")?.cause).toContain("回來了");
  });

  it("the crush in her voice channel satisfies longing over time", async () => {
    const h = await boot();
    makeCrush(h);
    h.clock.at += 6 * HOUR;
    const away = h.self.drives().longing;
    expect(away).toBeGreaterThan(0.3);
    h.world.her = { ...h.world.her, voice };
    h.world.members = ["1"];
    h.clock.at += HOUR;
    expect(h.self.drives().longing).toBeLessThan(away);
  });

  it("extensions can stir emotions with `self.feel`: the amount only picks a step", async () => {
    const h = await boot();
    h.publish(customEvent("self.feel", { emotion: "surprise", amount: 3, cause: "嚇到" }));
    h.publish(customEvent("self.feel", { toward: "gratitude", person: "p3", amount: 0.4 }));
    // Clamped to 0.5, which reads as a strong step (0.35).
    await vi.waitFor(() => expect(value(h, "surprise")).toBeCloseTo(0.35, 2));
    await vi.waitFor(() => expect(h.self.heart("p3")?.emotions.gratitude ?? 0).toBeCloseTo(0.4, 2));
  });
});

describe("felt and shown emotions", () => {
  it("keeps the felt and the shown emotion, her secret crush and feelings toward people", async () => {
    const h = await boot();
    expect(h.self.emotions()).toEqual([]);

    makeCrush(h);
    h.self.feel("joy", 0.3, "Owen 誇我", "p1");
    h.clock.at += 11 * MINUTE;
    h.self.feel("shy", 0.4, "Owen 誇我", "p1");
    h.self.feelToward("p3", "resentment", 0.5, "Carol 罵我");
    // Strongest first, with what stirred it.
    const felt = h.self.emotions();
    expect(felt[0]?.name).toBe("shy");
    expect(felt.map((e) => e.name)).toContain("joy");
    expect(h.self.shown()).toMatchObject({ from: "shy", tag: "embarrassed" });
    expect(h.self.crush()?.person).toBe("p1");
    expect(h.self.heart("p3")?.emotions.resentment ?? 0).toBeGreaterThan(0.4);
  });

  it("open display rules show the felt emotion as it is; no crush", async () => {
    const h = await boot("open");
    h.self.feel("missing", 0.5, "想念某個人");
    expect(h.self.shown()).toMatchObject({ from: "missing", tag: "sad", masked: false });
    // The snapshot has it all for the panel.
    const snap = h.self.snapshot();
    expect(snap.emotions?.[0]?.name).toBe("missing");
    expect(snap.shown?.tag).toBe("sad");
    expect(snap.crush).toBeNull();
  });

  it("the mood follows her emotions (affect) and history keeps samples", async () => {
    const h = await boot();
    h.self.feel("joy", 0.8, "");
    expect(h.self.affect().valence).toBeGreaterThan(0.3);
    h.self.sample();
    h.clock.at += 5 * MINUTE;
    h.self.sample();
    h.self.sample();
    const history = h.self.history();
    expect(history).toHaveLength(2);
    expect(history[0]?.emotions.joy).toBeGreaterThan(0.7);
  });
});
