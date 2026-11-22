import { type ArbiterDecision, Events, isSelfInitiated } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  acct,
  impulse,
  ManualClock,
  MIN,
  outcome,
  payloads,
  rig,
  textCtx,
  voiceCtx,
} from "./helpers.js";

const HERE = textCtx("c1");
const THERE = textCtx("c2");

describe("source classification", () => {
  it("only plan and agenda are her own initiative", () => {
    expect(isSelfInitiated("plan")).toBe(true);
    expect(isSelfInitiated("agenda")).toBe(true);
    for (const s of ["song", "game", "watch", "followup", "notice", "world", "message"] as const) {
      expect(isSelfInitiated(s)).toBe(false);
    }
  });

  it("song announcements are not counted, backed off or held to quiet hours", async () => {
    // 02:00 local: quiet hours.
    const r = rig({}, new ManualClock(Date.UTC(2026, 10, 2, 18, 0, 0)));
    for (let i = 0; i < 5; i++) {
      const d = await r.arbiter.submit(
        impulse(r.clock, { source: "song", context: HERE, reason: "song_start" }),
      );
      expect(d.verdict).toBe("accepted");
      r.clock.advance(MIN);
    }
    const limits = r.arbiter.ledger(HERE).limits;
    expect(limits.initiatives_today).toBe(0);
    expect(limits.unanswered_streak).toBe(0);
    expect(r.host.opened).toHaveLength(5);
    expect(r.host.opened[0]?.args.reason).toBe("song_start");
  });
});

describe("a watched stream's line", () => {
  it("has the priority of a game's", () => {
    const r = rig();
    const watch = impulse(r.clock, { source: "watch", context: HERE });
    const game = impulse(r.clock, { source: "game", context: HERE });
    expect(watch.priority).toBe(game.priority);
    expect(watch.priority).toBe("request");
  });

  it("is held by the same floors as a game's", async () => {
    const r = rig();
    const submit = (source: "watch" | "game", more = {}) =>
      r.arbiter.submit(impulse(r.clock, { source, context: HERE, ...more }));
    r.env.paused = true;
    expect(await submit("watch")).toMatchObject({ verdict: "rejected", reason: "paused" });
    r.env.paused = false;
    r.env.blocked.add("bad");
    expect((await submit("watch", { account: acct("bad") })).reason).toBe("consent");
    r.env.blocked.clear();
    r.host.set(THERE, { mode: "mention-only" });
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "watch", context: THERE }))).reason,
    ).toBe("ceiling");
    r.host.set(voiceCtx("v"), { present: false });
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "watch", context: voiceCtx("v") })))
        .reason,
    ).toBe("denied");
    expect((await submit("watch")).verdict).toBe("accepted");
    expect(r.host.opened.map((i) => i.source)).toContain("watch");
  });

  it("is not counted, backed off or held to quiet hours", async () => {
    // 02:00 local: quiet hours.
    const r = rig({}, new ManualClock(Date.UTC(2026, 10, 2, 18, 0, 0)));
    for (let i = 0; i < 5; i++) {
      const d = await r.arbiter.submit(impulse(r.clock, { source: "watch", context: HERE }));
      expect(d.verdict).toBe("accepted");
      r.clock.advance(MIN);
    }
    const limits = r.arbiter.ledger(HERE).limits;
    expect(limits.initiatives_today).toBe(0);
    expect(limits.unanswered_streak).toBe(0);
    expect(r.host.opened).toHaveLength(5);
  });
});

describe("her own starts", () => {
  it("are the new runner's: every one of them is refused here", async () => {
    const r = rig();
    for (const source of ["plan", "agenda", "world", "followup"] as const) {
      for (const kind of ["speak", "act"] as const) {
        const d = await r.arbiter.submit(
          impulse(r.clock, { source, kind, capability: "voice.join", context: HERE }),
        );
        expect(d).toMatchObject({ verdict: "rejected", reason: "denied" });
      }
    }
    expect(r.host.opened).toEqual([]);
  });
});

describe("floors", () => {
  it("pause, budget, consent and the channel level", async () => {
    const r = rig();
    r.env.paused = true;
    expect(
      await r.arbiter.submit(impulse(r.clock, { source: "game", context: HERE })),
    ).toMatchObject({ verdict: "rejected", reason: "paused" });
    // The owner's own sources are not held by the pause.
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "command", context: HERE }))).verdict,
    ).toBe("accepted");
    r.env.paused = false;
    r.env.budget = "degraded";
    // A song someone asked for still goes while the budget is only degraded.
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "song", context: HERE }))).verdict,
    ).toBe("accepted");
    r.env.budget = "exhausted";
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "song", context: HERE }))).reason,
    ).toBe("budget");
    r.env.budget = "ok";
    r.env.blocked.add("bad");
    expect(
      (
        await r.arbiter.submit(
          impulse(r.clock, { source: "game", context: HERE, account: acct("bad") }),
        )
      ).reason,
    ).toBe("consent");
    r.host.set(THERE, { mode: "mention-only" });
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "game", context: THERE }))).reason,
    ).toBe("ceiling");
    r.host.set(voiceCtx("v"), { present: false });
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "song", context: voiceCtx("v") }))).reason,
    ).toBe("denied");
  });

  it("after her game was closed she cannot start one herself, people still can", async () => {
    const r = rig();
    const start = (source: "plan" | "message") =>
      impulse(r.clock, { source, kind: "act", capability: "game.start", context: HERE });
    r.arbiter.gameClosed();
    const own = await r.arbiter.submit(start("plan"));
    expect(own.reason).toBe("denied");
    expect(r.arbiter.held("game.start")).toContain("不要自己重開");
    expect(JSON.stringify(await r.arbiter.submit(start("message")))).not.toContain("不要自己重開");
    expect(r.arbiter.limits(null).blocked.map((b) => b.capability)).toContain("game.start");
    r.clock.advance(61 * MIN);
    expect(r.arbiter.held("game.start")).toBeNull();
  });
});

describe("ordering, merging, expiry", () => {
  it("the same coalesce key merges (the newest wins)", async () => {
    const r = rig();
    r.host.busy.add("discord:g:c1");
    const a = impulse(r.clock, { source: "game", context: HERE, coalesce_key: "comment" });
    const b = impulse(r.clock, { source: "game", context: HERE, coalesce_key: "comment" });
    await r.arbiter.submit(a);
    await r.arbiter.submit(b);
    expect(r.arbiter.queued().map((i) => i.id)).toEqual([b.id]);
    const merged = payloads<ArbiterDecision>(r.events, Events.ArbiterDecided.type).find(
      (d) => d.verdict === "merged",
    );
    expect(merged).toMatchObject({ impulse: a.id, merged_into: b.id });
  });

  it("expired impulses are dropped, at submit and while waiting", async () => {
    const r = rig({ retry_ms: 1000 });
    const old = impulse(r.clock, { source: "song", context: HERE, ttlMs: 0 });
    expect((await r.arbiter.submit(old)).verdict).toBe("expired");
    r.host.busy.add("discord:g:c1");
    const short = impulse(r.clock, { source: "song", context: HERE, ttlMs: 5_000 });
    expect((await r.arbiter.submit(short)).verdict).toBe("deferred");
    r.clock.advance(6_000);
    await r.arbiter.pump();
    expect(r.arbiter.queued()).toHaveLength(0);
    const last = payloads<ArbiterDecision>(r.events, Events.ArbiterDecided.type).at(-1);
    expect(last).toMatchObject({ impulse: short.id, verdict: "expired" });
  });
});

describe("ledger", () => {
  it("record and resolve (ActivityManager / agent entries)", () => {
    const r = rig();
    const id = r.arbiter.record({
      kind: "task",
      source: "plan",
      context: null,
      person: null,
      summary: "開台",
      outcome: "pending",
      detail: null,
      impulse: null,
      turn: null,
      task: "task-7",
    });
    expect(r.arbiter.resolve(id, "failed", "OBS 沒開")).toBe(true);
    expect(r.arbiter.resolve("nope", "ok", null)).toBe(false);
    expect(r.arbiter.ledger().entries[0]).toMatchObject({ outcome: "failed", detail: "OBS 沒開" });
  });

  it("a task that failed after it ran is what did not work, not something on hold, for a while", () => {
    const r = rig();
    r.arbiter.record({
      kind: "task",
      source: "message",
      context: HERE,
      person: null,
      summary: "送魚幣給一個人",
      outcome: "failed",
      detail: "不知道「Lumen」是誰,沒有送出",
      impulse: null,
      turn: "t1",
      task: null,
    });
    const limits = r.arbiter.limits(HERE);
    expect(limits.blocked).toEqual([]);
    expect(limits.failed).toEqual([
      expect.objectContaining({
        capability: "送魚幣給一個人",
        reason: "不知道「Lumen」是誰,沒有送出",
      }),
    ]);
    r.clock.advance(31 * MIN);
    expect(r.arbiter.limits(HERE).failed).toBeUndefined();
  });

  it("an announcement nobody answers never raises the streak", async () => {
    const r = rig();
    const d = await r.arbiter.submit(impulse(r.clock, { source: "song", context: HERE }));
    r.arbiter.turnCompleted(d.turn as string, HERE, "我要唱下一首囉");
    r.arbiter.turnOutcome(outcome(d.turn as string, HERE, "sent"));
    r.clock.advance(30 * MIN);
    await r.arbiter.tick();
    expect(payloads(r.events, Events.AffectEvent.type)).toHaveLength(0);
    expect(r.arbiter.ledger().limits.unanswered_streak).toBe(0);
  });

  it("quiet hours are in the limits", () => {
    const r = rig({}, new ManualClock(Date.UTC(2026, 10, 2, 18, 30, 0)));
    const limits = r.arbiter.ledger().limits;
    expect(limits.quiet_hours).toEqual({ start_hour: 1, end_hour: 7, active: true });
    // 07:00 local.
    expect(limits.next_initiative_at).toBe(new Date(Date.UTC(2026, 10, 2, 23, 0, 0)).toISOString());
  });
});
