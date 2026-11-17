import { EventLogService } from "@miyoria/memory/facts";
import { Supervisor } from "@miyoria/runtime/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type AffectState,
  AffectStateKey,
  type AnyEventDefinition,
  type ArbiterDecision,
  ArbiterKey,
  type Attitude,
  type ContextKey,
  EventLogKey,
  Events,
  eventEnvelope,
  FloorKey,
  type Followup,
  type FollowupSource,
  FollowupSourceKey,
  ImpulseHostKey,
  type JsonValue,
  newImpulse,
  type SelfState,
  SelfStateKey,
  type SocialSignals,
  SocialSignalsKey,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArbiterCore, ArbiterModule, STATE_KEY, STATE_PROFILE } from "../src/index.js";
import { acct, FakeHost, MIN, T0, textCtx, voiceCtx } from "./helpers.js";

const ev = (definition: AnyEventDefinition, data: unknown) =>
  eventEnvelope("test", definition, data);

afterEach(() => {
  vi.useRealTimers();
});

class FakeSocial implements SocialSignals {
  readonly map = new Map<string, Attitude>();
  set(id: string, label: string, affinity: number, person = `person-${id}`): void {
    this.map.set(id, {
      person,
      affinity,
      trust: 50,
      familiarity: 50,
      blocked: false,
      label,
      call_name: null,
    });
  }
  attitude(account: AccountRef): Attitude | null {
    return this.map.get(account.id) ?? null;
  }
}

class FakeFollowups implements FollowupSource {
  due_: Followup[] = [];
  done: string[] = [];
  async due(): Promise<Followup[]> {
    return this.due_.filter((f) => !this.done.includes(f.id));
  }
  async markDone(id: string): Promise<void> {
    this.done.push(id);
  }
}

function messageData(ctx: ContextKey, who: string, at: number, mentions = false) {
  return {
    id: { context: ctx, id: `${who}-${at}` },
    author: { account: acct(who), display_name: who, is_bot: who === "me" },
    text: "hi",
    mentions_self: mentions,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(at),
  };
}

const _message = (ctx: ContextKey, who: string, at: number, mentions = false) =>
  ev(Events.PlatformMessageCreated, messageData(ctx, who, at, mentions));

function _participant(id: string): VoiceParticipant {
  return {
    account: acct(id),
    display_name: id,
    is_self: id === "me",
    muted: false,
    deafened: false,
  };
}

describe("ArbiterModule", () => {
  async function build(config: JsonValue | null = null) {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const sup = new Supervisor();
    const host = new FakeHost();
    const social = new FakeSocial();
    const followups = new FakeFollowups();
    const store = new MemorySettingsStore();
    sup.services.provide("app", ImpulseHostKey, host);
    sup.services.provide("app", SocialSignalsKey, social);
    sup.services.provide("app", FollowupSourceKey, followups);
    sup.services.provide("app", SettingsStoreKey, store);
    const decisions = sup.bus.subscribe(Events.ArbiterDecided.type);
    await sup.register(new ArbiterModule("p"), config, true);
    await sup.startAll();
    return { sup, host, social, followups, store, decisions };
  }

  it("provides ArbiterKey and takes impulses from the topic", async () => {
    const h = await build();
    const arbiter = h.sup.services.get(ArbiterKey);
    expect(arbiter).toBeDefined();
    const imp = newImpulse(
      { source: "song", context: textCtx("c1"), ttlMs: MIN, why: "報幕", reason: "song_start" },
      Date.now(),
    );
    h.sup.bus.publish("sing", Events.ArbiterImpulse, imp);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.host.opened.map((i) => i.id)).toEqual([imp.id]);
    const env = h.decisions.tryRecv();
    expect(env?.data as ArbiterDecision | undefined).toMatchObject({
      impulse: imp.id,
      verdict: "accepted",
    });
    await h.sup.stopAll();
  });
});

describe("the Floor's module", () => {
  async function floorRig(config: JsonValue = null, store: MemorySettingsStore | null = null) {
    const sup = new Supervisor();
    if (store) sup.services.provide("app", SettingsStoreKey, store);
    const log = new EventLogService({ profile: "p", store: null });
    const social = new FakeSocial();
    social.set("a", "朋友", 60);
    const followups = new FakeFollowups();
    const host = new FakeHost();
    sup.services.provide("app", EventLogKey, log);
    sup.services.provide("app", SocialSignalsKey, social);
    sup.services.provide("app", FollowupSourceKey, followups);
    sup.services.provide("app", ImpulseHostKey, host);
    await sup.register(new ArbiterModule("p"), config, true);
    await sup.startAll();
    return { sup, log, followups, host, social };
  }

  it("provides the Floor", async () => {
    const r = await floorRig();
    expect(r.sup.services.get(FloorKey)).toBeDefined();
    await r.sup.stopAll();
  });

  it("her feelings reach the budget as a weight, her own setting stays apart", async () => {
    const r = await floorRig();
    const snapshot = { biases: { talkativeness: 0 } };
    const talk = { level: 0.5 };
    r.sup.services.provide("app", AffectStateKey, {
      snapshot: () => snapshot,
    } as unknown as AffectState);
    r.sup.services.provide("app", SelfStateKey, {
      talkativeness: () => ({ level: talk.level, scope: "x" }),
    } as unknown as SelfState);
    const floor = r.sup.services.require(FloorKey);
    const allowed = () => floor.budget(voiceCtx("v")).allowed;
    expect(allowed()).toBe(6);
    snapshot.biases.talkativeness = 0.4;
    expect(allowed()).toBe(7);
    snapshot.biases.talkativeness = -0.4;
    expect(allowed()).toBe(3);
    // She set herself to quiet: a bad mood halves that, and no less than a line.
    talk.level = 0.1;
    expect(allowed()).toBe(1);
    await r.sup.stopAll();
  });

  it("a notable game observation asks for the mic; an ambient one does not", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const r = await floorRig();
    const observation = (salience: "ambient" | "notable", key: string) => ({
      source: "game.minecraft",
      silent: salience === "ambient",
      salience,
      attention_key: key,
      revision: 1,
      summary: key,
      addressed_to_her: false,
      from: null,
      context: voiceCtx("v1"),
    });
    r.log.observe(observation("ambient", "game:tick"));
    r.log.observe(observation("notable", "game:craft:stone_pickaxe"));
    await vi.advanceTimersByTimeAsync(10);
    expect(r.host.opened.map((i) => i.attention?.key)).toEqual(["game:craft:stone_pickaxe"]);
    await r.sup.stopAll();
  });

  it("an act impulse has nothing to run it: only a turn acts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const r = await floorRig();
    const decision = await r.sup.services.require(ArbiterKey).submit(
      newImpulse(
        {
          source: "game",
          kind: "act",
          context: textCtx("c1"),
          capability: "game.act",
          ttlMs: MIN,
          why: "",
        },
        T0,
      ),
    );
    expect(decision.verdict).toBe("rejected");
    await r.sup.stopAll();
  });

  it("saves her state on stop and reads it back on start: a hold survives a restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = new MemorySettingsStore();
    const first = await floorRig(null, store);
    (first.sup.services.require(ArbiterKey) as ArbiterCore).gameClosed();
    expect(first.sup.services.require(ArbiterKey).held?.("game.start")).not.toBeNull();
    // No tick has passed (30 s): what is saved is written by the stop.
    expect(await store.get(STATE_PROFILE, STATE_KEY)).toBeNull();
    await first.sup.stopAll();
    const saved = (await store.get(STATE_PROFILE, STATE_KEY)) as {
      holds: { capability: string }[];
    };
    expect(saved.holds.map((h) => h.capability)).toEqual(["game.start"]);

    await vi.advanceTimersByTimeAsync(MIN);
    const second = await floorRig(null, store);
    expect(second.sup.services.require(ArbiterKey).held?.("game.start")).not.toBeNull();
    await second.sup.stopAll();
  });

  it("an older saved state with the producers' part still loads", async () => {
    const store = new MemorySettingsStore();
    await store.set(STATE_PROFILE, STATE_KEY, {
      ledger: {},
      producers: { seen: [[{ platform: "test", id: "a" }, 3]] },
      holds: [{ capability: "game.start", reason: "x", until: Date.now() + 10 * MIN }],
    });
    const r = await floorRig(null, store);
    expect(r.sup.services.require(ArbiterKey).held?.("game.start")).not.toBeNull();
    await r.sup.stopAll();
  });
});
