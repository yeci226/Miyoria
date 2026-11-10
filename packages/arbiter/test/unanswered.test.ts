// Repeats and talking to nobody (docs/design/v3-architecture.md §7.2, §8), and the opposite
// failure, 她變啞巴: what these two rules must never touch.

import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  ARBITER_DECISION_TOPIC,
  ARBITER_IMPULSE_TOPIC,
  type ArbiterDecision,
  type ContextKey,
  type Event,
  type Impulse,
  ImpulseHostKey,
  LEDGER_TOPIC,
  type LedgerEntry,
  newImpulse,
  toTimestamp,
  type VoiceUtterance,
  v2Event,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArbiterModule,
  humanResponse,
  LedgerSnapshotSchema,
  STATE_KEY,
  STATE_PROFILE,
  startsTalk,
} from "../src/index.js";
import {
  acct,
  FakeHost,
  impulse,
  ManualClock,
  MIN,
  outcome,
  payloads,
  type Rig,
  rig,
  T0,
  textCtx,
  voiceCtx,
} from "./helpers.js";

const VOICE = voiceCtx("v1");
const OTHER = voiceCtx("v2");
const PICKAXE = "game:craft:stone_pickaxe";
const REPEAT_MS = 45 * MIN;

afterEach(() => {
  vi.useRealTimers();
});

function narration(r: Rig, key: string, context: ContextKey = VOICE, repeatMs = REPEAT_MS) {
  return impulse(r.clock, {
    source: "game",
    context,
    reason: "game",
    attention: { key, repeat_after_ms: repeatMs },
  });
}

/** Her turn of `d` went out (or stayed silent). */
function ended(
  r: Rig,
  d: ArbiterDecision,
  context: ContextKey = VOICE,
  type: "sent" | "silence" = "sent",
): void {
  r.arbiter.turnOutcome(outcome(d.turn as string, context, type, "initiative", r.clock.now()));
}

let lines = 0;

/** `n` lines about different things went out in `context`. */
async function talkToNobody(r: Rig, n: number, context: ContextKey = VOICE): Promise<void> {
  for (let i = 0; i < n; i++) {
    lines += 1;
    const d = await r.arbiter.submit(narration(r, `game:remark:${lines}`, context));
    expect(d.verdict).toBe("accepted");
    ended(r, d, context);
    r.clock.advance(MIN);
  }
}

describe("the same thing is not said twice", () => {
  it("the second ask of a key is rejected with its reason, however it was worded", async () => {
    const r = rig();
    const first = await r.arbiter.submit(narration(r, PICKAXE));
    expect(first.verdict).toBe("accepted");
    ended(r, first);
    r.clock.advance(MIN);
    const again = await r.arbiter.submit(narration(r, PICKAXE));
    expect(again).toMatchObject({ verdict: "rejected", reason: "repeat" });
    expect(again.retry_at).toBe(toTimestamp(T0 + REPEAT_MS));
    expect(r.host.opened).toHaveLength(1);
  });

  it("25 asks in two hours are 3 lines at the default window, not 25", async () => {
    const r = rig({ max_unanswered: 0 });
    let said = 0;
    for (let i = 0; i < 25; i++) {
      const d = await r.arbiter.submit(narration(r, PICKAXE));
      if (d.verdict === "accepted") {
        said += 1;
        ended(r, d);
      }
      r.clock.advance(5 * MIN);
    }
    expect(said).toBe(3);
  });

  it("after the window a new occurrence counts as a new revision", async () => {
    const r = rig();
    const first = await r.arbiter.submit(narration(r, PICKAXE));
    ended(r, first);
    r.clock.advance(REPEAT_MS - 1);
    expect((await r.arbiter.submit(narration(r, PICKAXE))).verdict).toBe("rejected");
    r.clock.advance(1);
    expect((await r.arbiter.submit(narration(r, PICKAXE))).verdict).toBe("accepted");
  });

  it("the source sets the window: a hazard comes back sooner", async () => {
    const r = rig();
    const first = await r.arbiter.submit(narration(r, "game:hostile_near:zombie", VOICE, 2 * MIN));
    ended(r, first);
    r.clock.advance(2 * MIN);
    const d = await r.arbiter.submit(narration(r, "game:hostile_near:zombie", VOICE, 2 * MIN));
    expect(d.verdict).toBe("accepted");
  });

  it("another key is another thing", async () => {
    const r = rig();
    ended(r, await r.arbiter.submit(narration(r, PICKAXE)));
    expect((await r.arbiter.submit(narration(r, "game:craft:iron_pickaxe"))).verdict).toBe(
      "accepted",
    );
  });

  it("a line that was not delivered was not said", async () => {
    const r = rig();
    // She stayed silent.
    ended(r, await r.arbiter.submit(narration(r, PICKAXE)), VOICE, "silence");
    const second = await r.arbiter.submit(narration(r, PICKAXE));
    expect(second.verdict).toBe("accepted");
    // Cancelled, or it failed.
    r.arbiter.turnOutcome({
      ...outcome(second.turn as string, VOICE, "sent"),
      outcome: { type: "cancelled", cause: "superseded", by: null },
    });
    const third = await r.arbiter.submit(narration(r, PICKAXE));
    expect(third.verdict).toBe("accepted");
    // The place was busy and it expired waiting.
    const s = rig();
    s.host.busy.add("discord:g:voice:v1");
    const busy = await s.arbiter.submit(narration(s, PICKAXE));
    expect(busy.verdict).toBe("deferred");
    s.host.busy.clear();
    s.clock.advance(11 * MIN);
    await s.arbiter.pump();
    expect((await s.arbiter.submit(narration(s, PICKAXE))).verdict).toBe("accepted");
  });

  it("a line in flight blocks its repeat before the turn ends", async () => {
    const r = rig();
    await r.arbiter.submit(narration(r, PICKAXE));
    const second = await r.arbiter.submit(narration(r, PICKAXE));
    expect(second).toMatchObject({ verdict: "rejected", reason: "repeat" });
  });

  it("a repeat does not push out something new that waits for a free moment", async () => {
    const r = rig();
    const said = { ...narration(r, PICKAXE), coalesce_key: "game" };
    ended(r, await r.arbiter.submit(said));
    r.host.busy.add("discord:g:voice:v1");
    const fresh = { ...narration(r, "game:advancement:鑽石"), coalesce_key: "game" };
    expect((await r.arbiter.submit(fresh)).verdict).toBe("deferred");
    const again = { ...narration(r, PICKAXE), coalesce_key: "game" };
    expect((await r.arbiter.submit(again)).reason).toBe("repeat");
    expect(r.arbiter.queued().map((q) => q.id)).toEqual([fresh.id]);
    // Something else that is new does take its place, as before.
    const newer = { ...narration(r, "game:craft:iron_pickaxe"), coalesce_key: "game" };
    await r.arbiter.submit(newer);
    expect(r.arbiter.queued().map((q) => q.id)).toEqual([newer.id]);
  });

  it("a rejected repeat says why on the bus but does not fill her ledger", async () => {
    const r = rig();
    ended(r, await r.arbiter.submit(narration(r, PICKAXE)));
    const before = payloads<LedgerEntry>(r.events, LEDGER_TOPIC).length;
    for (let i = 0; i < 20; i++) await r.arbiter.submit(narration(r, PICKAXE));
    expect(payloads<LedgerEntry>(r.events, LEDGER_TOPIC)).toHaveLength(before);
    const rejected = payloads<ArbiterDecision>(r.events, ARBITER_DECISION_TOPIC).filter(
      (d) => d.reason === "repeat",
    );
    expect(rejected).toHaveLength(20);
  });
});

describe("max_unanswered", () => {
  it("narration stops at the limit and the reason is visible", async () => {
    const r = rig();
    await talkToNobody(r, 3);
    const d = await r.arbiter.submit(narration(r, "game:remark:new"));
    expect(d).toMatchObject({ verdict: "rejected", reason: "unanswered", retry_at: null });
    expect(r.host.opened).toHaveLength(3);
    const limits = r.arbiter.ledger(VOICE).limits;
    expect(limits.waiting_for_response).toBe(true);
    expect(limits.blocked[0]).toMatchObject({ capability: "chat.start", until: null });
    expect(limits.blocked[0]?.reason).toContain("等有人說話");
  });

  it("the limit is configurable, and 0 turns it off", async () => {
    const one = rig({ max_unanswered: 1 });
    await talkToNobody(one, 1);
    expect((await one.arbiter.submit(narration(one, "x"))).verdict).toBe("rejected");
    const off = rig({ max_unanswered: 0 });
    await talkToNobody(off, 10);
    expect(off.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(false);
  });

  it("stops her own start and a memory followup too", async () => {
    const r = rig({ min_gap_secs: 0, gap_voice_secs: 0 });
    await talkToNobody(r, 3);
    const plan = await r.arbiter.submit(impulse(r.clock, { source: "plan", context: VOICE }));
    expect(plan).toMatchObject({ verdict: "rejected", reason: "unanswered" });
    const memory = await r.arbiter.submit(
      impulse(r.clock, { source: "followup", context: VOICE, reason: "followup" }),
    );
    expect(memory).toMatchObject({ verdict: "rejected", reason: "unanswered" });
  });

  it("every kind of start counts", async () => {
    const r = rig({ min_gap_secs: 0, gap_voice_secs: 0, after_speech_voice_secs: 0 });
    ended(r, await r.arbiter.submit(impulse(r.clock, { source: "plan", context: VOICE })));
    ended(
      r,
      await r.arbiter.submit(
        impulse(r.clock, { source: "followup", context: VOICE, reason: "followup" }),
      ),
    );
    ended(r, await r.arbiter.submit(narration(r, PICKAXE)));
    expect(r.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(true);
  });

  it("a turn in which she said nothing does not count", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      ended(r, await r.arbiter.submit(narration(r, `k${i}`)), VOICE, "silence");
    }
    expect(r.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(false);
  });

  it("each context counts on its own", async () => {
    const r = rig();
    await talkToNobody(r, 3);
    expect((await r.arbiter.submit(narration(r, "elsewhere", OTHER))).verdict).toBe("accepted");
    expect(r.arbiter.ledger(OTHER).limits.waiting_for_response).toBe(false);
  });

  it("anyone speaking there resets it, addressed to her or not, and elsewhere does not", async () => {
    const r = rig();
    await talkToNobody(r, 3);
    r.arbiter.heard(OTHER, acct("a"));
    expect(r.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(true);
    r.arbiter.heard(VOICE, acct("a"));
    expect(r.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(false);
    expect((await r.arbiter.submit(narration(r, "game:remark:back"))).verdict).toBe("accepted");
  });

  it("someone addressing her resets it through her own books too", async () => {
    const r = rig();
    await talkToNobody(r, 3);
    r.arbiter.engaged(VOICE, null);
    expect(r.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(false);
  });

  it("a line in the text chat of the voice channel is the same room", async () => {
    const r = rig();
    await talkToNobody(r, 3);
    r.arbiter.heard({ ...VOICE, kind: "channel" }, acct("a"));
    expect(r.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(false);
  });

  it("a DM counts per partner", async () => {
    const r = rig({ min_gap_secs: 0, gap_text_secs: 0 });
    const dm: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };
    const talk = (): Impulse =>
      impulse(r.clock, { source: "plan", context: dm, account: acct("a") });
    for (let i = 0; i < 3; i++) ended(r, await r.arbiter.submit(talk()), dm);
    expect((await r.arbiter.submit(talk())).reason).toBe("unanswered");
    r.arbiter.heard(dm, acct("a"));
    expect((await r.arbiter.submit(talk())).verdict).toBe("accepted");
  });

  it("she has three lines again after every time a person spoke", async () => {
    const r = rig();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) {
        const d = await r.arbiter.submit(narration(r, `round${round}:${i}`));
        expect(d.verdict).toBe("accepted");
        ended(r, d);
      }
      expect(r.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(true);
      r.arbiter.heard(VOICE, acct("a"));
    }
  });
});

describe("what counts", () => {
  it("startsTalk: her wishes, narration and memory followups only", () => {
    const clock = new ManualClock();
    const of = (i: Parameters<typeof impulse>[1]) => startsTalk(impulse(clock, i));
    expect(of({ source: "plan", context: VOICE })).toBe(true);
    expect(of({ source: "agenda", context: VOICE })).toBe(true);
    expect(of({ source: "followup", context: VOICE, reason: "followup" })).toBe(true);
    expect(
      of({
        source: "game",
        context: VOICE,
        attention: { key: "k", repeat_after_ms: 1 },
      }),
    ).toBe(true);
    expect(of({ source: "game", context: VOICE })).toBe(false);
    expect(of({ source: "followup", context: VOICE, reason: "action_result" })).toBe(false);
    for (const source of ["song", "notice", "world", "message", "command", "panel"] as const) {
      expect(of({ source, context: VOICE })).toBe(false);
    }
  });

  const message = (who: string, isBot: boolean): Event => ({
    type: "platform_message_created",
    data: {
      id: { context: textCtx("c"), id: "m" },
      author: { account: acct(who), display_name: who, is_bot: isBot },
      text: "hi",
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(T0),
    },
  });
  const utterance = (who: string, text: string, isBot = false): Event => ({
    type: "voice_utterance",
    data: {
      context: VOICE,
      speaker: { account: acct(who), display_name: who, is_bot: isBot },
      text,
    } as unknown as VoiceUtterance,
  });
  const isSelf = (a: { id: string }): boolean => a.id === "her";

  it("humanResponse: a person's message or speech, addressed to her or not", () => {
    expect(humanResponse(message("a", false), isSelf)).toEqual({
      context: textCtx("c"),
      account: acct("a"),
    });
    expect(humanResponse(utterance("a", "嗯。"), isSelf)).toEqual({
      context: VOICE,
      account: acct("a"),
    });
  });

  it("humanResponse: not her, not bots, not silence, not people coming and going", () => {
    expect(humanResponse(message("her", false), isSelf)).toBeNull();
    expect(humanResponse(message("b", true), isSelf)).toBeNull();
    expect(humanResponse(utterance("her", "欸"), isSelf)).toBeNull();
    expect(humanResponse(utterance("b", "欸", true), isSelf)).toBeNull();
    expect(humanResponse(utterance("a", "   "), isSelf)).toBeNull();
    expect(
      humanResponse(
        { type: "voice_participants", data: { context: VOICE, participants: [] } },
        isSelf,
      ),
    ).toBeNull();
  });
});

describe("she does not go mute: never limited, however quiet the room is", () => {
  /** She reached the limit and has said the pickaxe. */
  async function silenced(): Promise<Rig> {
    const r = rig();
    ended(r, await r.arbiter.submit(narration(r, PICKAXE)));
    await talkToNobody(r, 2);
    expect(r.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(true);
    return r;
  }

  const FREE: [string, Parameters<typeof impulse>[1]][] = [
    ["a reply to someone", { source: "message", context: VOICE }],
    ["a slash command", { source: "command", context: VOICE }],
    ["the panel's 讓她說", { source: "panel", context: VOICE }],
    ["a song announcement", { source: "song", context: VOICE, reason: "song_start" }],
    ["a song result", { source: "song", context: VOICE, reason: "song_done" }],
    ["a notice", { source: "notice", context: VOICE, reason: "notice" }],
    ["a result she promised", { source: "followup", context: VOICE, reason: "action_result" }],
    ["an urgent game event", { source: "game", context: VOICE, reason: "game" }],
    ["a greeting", { source: "world", context: VOICE, reason: "voice_join" }],
  ];

  for (const [what, input] of FREE) {
    it(`${what} goes out and does not count as talking to nobody`, async () => {
      const r = await silenced();
      const d = await r.arbiter.submit(impulse(r.clock, input));
      expect(d.verdict).toBe("accepted");
      ended(r, d);
      r.arbiter.heard(VOICE, acct("a"));
      // Reset, and that turn added nothing: the three lines are all there.
      await talkToNobody(r, 3);
    });
  }

  it("her own actions go through: only her words wait", async () => {
    const r = await silenced();
    const d = await r.arbiter.submit(
      impulse(r.clock, { source: "plan", kind: "act", capability: "game.goal", context: VOICE }),
    );
    expect(d.verdict).toBe("accepted");
  });

  it("a line without a key is never a repeat", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      const d = await r.arbiter.submit(
        impulse(r.clock, { source: "game", context: VOICE, reason: "game" }),
      );
      expect(d.verdict).toBe("accepted");
      ended(r, d);
    }
  });

  it("repeating one thing does not take away the next one", async () => {
    const r = rig({ max_unanswered: 0 });
    ended(r, await r.arbiter.submit(narration(r, PICKAXE)));
    for (let i = 0; i < 10; i++) await r.arbiter.submit(narration(r, PICKAXE));
    expect((await r.arbiter.submit(narration(r, "game:advancement:鑽石"))).verdict).toBe(
      "accepted",
    );
  });

  it("rejected repeats do not use up her count", async () => {
    const r = rig();
    ended(r, await r.arbiter.submit(narration(r, PICKAXE)));
    for (let i = 0; i < 10; i++) await r.arbiter.submit(narration(r, PICKAXE));
    expect(r.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(false);
    await talkToNobody(r, 2);
  });

  it("a person present: she still starts talking on her own", async () => {
    const r = rig({ min_gap_secs: 0, gap_voice_secs: 0, after_speech_voice_secs: 0 });
    for (let i = 0; i < 12; i++) {
      r.arbiter.heard(VOICE, acct("a"));
      const d = await r.arbiter.submit(
        i % 2 === 0
          ? impulse(r.clock, { source: "plan", context: VOICE })
          : narration(r, `game:remark:${i}`),
      );
      if (d.reason === "rate") break; // Her daily caps, which are older rules.
      expect(d.verdict).toBe("accepted");
      ended(r, d);
    }
    expect(r.host.opened.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the state survives a restart", () => {
  it("snapshot and restore keep the count and what was said", async () => {
    const r = rig();
    ended(r, await r.arbiter.submit(narration(r, PICKAXE)));
    await talkToNobody(r, 2);
    const saved = LedgerSnapshotSchema.parse(
      JSON.parse(JSON.stringify(r.arbiter.book.snapshot(r.clock.now()))),
    );
    const next = rig({}, new ManualClock(r.clock.now()));
    next.arbiter.book.restore(saved, r.clock.now());
    expect(next.arbiter.ledger(VOICE).limits.waiting_for_response).toBe(true);
    next.arbiter.heard(VOICE, acct("a"));
    expect(await next.arbiter.submit(narration(next, PICKAXE))).toMatchObject({
      verdict: "rejected",
      reason: "repeat",
    });
  });

  it("an older saved state still loads", () => {
    const old = {
      starts: [],
      places: [{ key: "k", kind: "voice", context: null, misses: 1, misses_at: 0 }],
      streak: 0,
      topics: [],
    };
    const parsed = LedgerSnapshotSchema.parse(old);
    expect(parsed.said).toEqual([]);
    expect(parsed.places[0]?.unanswered).toBe(0);
  });
});

describe("the module", () => {
  async function build() {
    const sup = new Supervisor();
    const host = new FakeHost();
    const store = new MemorySettingsStore();
    sup.services.provide("app", ImpulseHostKey, host);
    sup.services.provide("app", SettingsStoreKey, store);
    await sup.register(new ArbiterModule("p"), {}, true);
    await sup.startAll();
    const decisions: ArbiterDecision[] = [];
    const sub = sup.bus.subscribe(ARBITER_DECISION_TOPIC);
    void (async () => {
      for await (const env of sub) {
        if (env.event.type === "custom") {
          decisions.push(env.event.data.payload as unknown as ArbiterDecision);
        }
      }
    })();
    const say = async (n: number, key: string): Promise<void> => {
      sup.bus.publish(
        "game",
        v2Event(
          ARBITER_IMPULSE_TOPIC,
          newImpulse(
            {
              source: "game",
              context: VOICE,
              ttlMs: MIN,
              why: "實況",
              hint: "石鎬",
              reason: "game",
              attention: { key: `${key}${n}`, repeat_after_ms: REPEAT_MS },
            },
            Date.now(),
          ),
        ),
      );
      await vi.advanceTimersByTimeAsync(5);
    };
    const finish = async (): Promise<void> => {
      for (const d of decisions.filter((x) => x.verdict === "accepted" && x.turn !== null)) {
        if (ended_.has(d.turn as string)) continue;
        ended_.add(d.turn as string);
        sup.bus.publish("agent", {
          type: "custom",
          data: {
            topic: "agent.turn.outcome",
            payload: outcome(d.turn as string, VOICE, "sent") as never,
          },
        });
      }
      await vi.advanceTimersByTimeAsync(5);
    };
    const ended_ = new Set<string>();
    return { sup, host, store, decisions, say, finish };
  }

  const speech = (who: string): Event => ({
    type: "voice_utterance",
    data: {
      context: VOICE,
      speaker: { account: acct(who), display_name: who, is_bot: false },
      text: "嗯",
    } as unknown as VoiceUtterance,
  });

  async function stopped(h: Awaited<ReturnType<typeof build>>): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await h.say(i, "a");
      await h.finish();
    }
    await h.say(9, "a");
    expect(h.decisions.at(-1)).toMatchObject({ verdict: "rejected", reason: "unanswered" });
  }

  it("real speech on the bus brings her back, and the state is saved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const h = await build();
    await stopped(h);
    await vi.advanceTimersByTimeAsync(31_000);
    const saved = (await h.store.get(STATE_PROFILE, STATE_KEY)) as {
      ledger: { places: { unanswered: number }[] };
    };
    expect(saved.ledger.places[0]?.unanswered).toBe(3);
    h.sup.bus.publish("voice", speech("a"));
    await vi.advanceTimersByTimeAsync(5);
    await h.say(10, "a");
    expect(h.decisions.at(-1)?.verdict).toBe("accepted");
    await h.sup.stopAll();
  });

  it("a new stay in voice starts counting again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const h = await build();
    await stopped(h);
    h.sup.bus.publish("voice", { type: "voice_left", data: { context: VOICE } } as Event);
    await vi.advanceTimersByTimeAsync(5);
    await h.say(11, "a");
    expect(h.decisions.at(-1)?.verdict).toBe("accepted");
    await h.sup.stopAll();
  });
});
