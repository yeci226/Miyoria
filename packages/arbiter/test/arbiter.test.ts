import {
  AFFECT_EVENT_TOPIC,
  type AffectEvent,
  ARBITER_DECISION_TOPIC,
  type ArbiterDecision,
  isSelfInitiated,
  LEDGER_TOPIC,
  type LedgerEntry,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  acct,
  impulse,
  ManualClock,
  MIN,
  outcome,
  payloads,
  rig,
  T0,
  textCtx,
  voiceCtx,
} from "./helpers.js";

const HERE = textCtx("c1");
const THERE = textCtx("c2");

describe("source classification", () => {
  it("only plan and agenda are her own initiative", () => {
    expect(isSelfInitiated("plan")).toBe(true);
    expect(isSelfInitiated("agenda")).toBe(true);
    for (const s of ["song", "game", "followup", "notice", "world", "message"] as const) {
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
    // Her own start is still held to quiet hours.
    const own = await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE }));
    expect(own).toMatchObject({ verdict: "rejected", reason: "quiet_hours" });
  });
});

describe("her own act impulses", () => {
  it("are not topics she opens: no caps or gaps, but quiet hours", async () => {
    const r = rig({ max_per_day: 1 });
    for (const _ of [1, 2, 3]) {
      const d = await r.arbiter.submit(
        impulse(r.clock, { source: "plan", kind: "act", capability: "sing.play", context: HERE }),
      );
      expect(d.verdict).toBe("accepted");
    }
    expect(r.arbiter.ledger().limits.initiatives_today).toBe(0);
    const night = rig({}, new ManualClock(Date.UTC(2026, 10, 2, 18, 0, 0)));
    const d = await night.arbiter.submit(
      impulse(night.clock, {
        source: "plan",
        kind: "act",
        capability: "voice.join",
        context: HERE,
      }),
    );
    expect(d).toMatchObject({ verdict: "rejected", reason: "quiet_hours" });
  });
});

describe("floors", () => {
  it("pause, budget, consent and the channel level", async () => {
    const r = rig();
    r.env.paused = true;
    expect(
      await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE })),
    ).toMatchObject({ verdict: "rejected", reason: "paused" });
    // The owner's own sources are not held by the pause.
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "command", context: HERE }))).verdict,
    ).toBe("accepted");
    r.env.paused = false;
    r.env.budget = "degraded";
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "world", context: HERE }))).reason,
    ).toBe("budget");
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
          impulse(r.clock, { source: "followup", context: HERE, account: acct("bad") }),
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

  it("does not need her in a voice channel to go there", async () => {
    const r = rig();
    r.host.set(voiceCtx("v"), { present: false });
    const join = impulse(r.clock, {
      source: "plan",
      kind: "act",
      capability: "voice.join",
      context: voiceCtx("v"),
    });
    expect((await r.arbiter.submit(join)).reason).not.toBe("denied");
  });

  it("daily, per-place and per-person caps", async () => {
    const r = rig({
      min_gap_secs: 0,
      gap_text_secs: 0,
      max_per_day: 3,
      max_per_context_per_day: 2,
    });
    const plan = (ctx = HERE, who: string | null = null) =>
      r.arbiter.submit(
        impulse(r.clock, { source: "plan", context: ctx, account: who ? acct(who) : null }),
      );
    expect((await plan()).verdict).toBe("accepted");
    expect((await plan()).verdict).toBe("accepted");
    const third = await plan();
    expect(third).toMatchObject({ verdict: "rejected", reason: "rate" });
    expect(third.detail).toContain("今天在這裡主動開了 2 次");
    expect((await plan(THERE)).verdict).toBe("accepted");
    const cap = await plan(textCtx("c3"));
    expect(cap).toMatchObject({ verdict: "rejected", reason: "rate" });
    expect(cap.detail).toContain("今天主動開了 3 次話題(上限 3)");
    // Next local day (04:00).
    expect(Date.parse(cap.retry_at as string)).toBe(Date.UTC(2026, 10, 3, 20, 0, 0));

    const p = rig({ min_gap_secs: 0, gap_text_secs: 0, max_per_person_per_day: 1 });
    const first = await p.arbiter.submit(
      impulse(p.clock, { source: "plan", context: HERE, account: acct("owen") }),
    );
    expect(first.verdict).toBe("accepted");
    const again = await p.arbiter.submit(
      impulse(p.clock, { source: "plan", context: THERE, account: acct("owen") }),
    );
    expect(again).toMatchObject({ verdict: "rejected", reason: "rate" });
  });

  it("gaps: between any two starts, per place, and the level's gap", async () => {
    const r = rig({ min_gap_secs: 60, gap_text_secs: 600 });
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE }))).verdict,
    ).toBe("accepted");
    const soon = await r.arbiter.submit(impulse(r.clock, { source: "plan", context: THERE }));
    expect(soon).toMatchObject({ verdict: "rejected", reason: "cooldown" });
    expect(Date.parse(soon.retry_at as string)).toBe(T0 + 60_000);
    r.clock.advance(2 * MIN);
    expect(
      (await r.arbiter.submit(impulse(r.clock, { source: "plan", context: THERE }))).verdict,
    ).toBe("accepted");
    r.clock.advance(2 * MIN);
    const here = await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE }));
    expect(here).toMatchObject({ verdict: "rejected", reason: "cooldown" });
    expect(Date.parse(here.retry_at as string)).toBe(T0 + 10 * MIN);
    expect(here.detail).toContain("4 分鐘前");

    const lvl = rig({ min_gap_secs: 0, gap_text_secs: 60 });
    lvl.host.set(HERE, { mode: "quiet", start_gap_ms: 3 * 60 * MIN });
    await lvl.arbiter.submit(impulse(lvl.clock, { source: "plan", context: HERE }));
    lvl.clock.advance(10 * MIN);
    expect(
      await lvl.arbiter.submit(impulse(lvl.clock, { source: "plan", context: HERE })),
    ).toMatchObject({ verdict: "rejected", reason: "ceiling" });
  });

  it("greetings wait a moment after she spoke (deferred, then retried)", async () => {
    const r = rig({ after_speech_text_secs: 5 });
    r.host.set(HERE, { last_spoke_at: T0 - 2_000 });
    const d = await r.arbiter.submit(impulse(r.clock, { source: "world", context: HERE }));
    expect(d).toMatchObject({ verdict: "deferred", reason: "cooldown" });
    expect(r.arbiter.queued()).toHaveLength(1);
    r.clock.advance(4_000);
    await r.arbiter.pump();
    expect(r.host.opened).toHaveLength(1);
  });
});

describe("ordering, merging, preemption, expiry", () => {
  it("a busy place defers; the most urgent goes first once it is free", async () => {
    const r = rig({ retry_ms: 1000 });
    r.host.busy.add("discord:g:c1");
    const mine = impulse(r.clock, { source: "plan", context: HERE });
    const song = impulse(r.clock, { source: "song", context: HERE });
    expect((await r.arbiter.submit(mine)).verdict).toBe("deferred");
    expect((await r.arbiter.submit(song)).verdict).toBe("deferred");
    expect(r.arbiter.queued().map((i) => i.source)).toEqual(["song", "plan"]);
    r.host.busy.clear();
    r.clock.advance(1000);
    await r.arbiter.pump();
    // The song went; her own wish waiting there was preempted by it.
    expect(r.host.opened.map((i) => i.source)).toEqual(["song"]);
    const decisions = payloads<ArbiterDecision>(r.events, ARBITER_DECISION_TOPIC);
    expect(decisions.find((d) => d.impulse === mine.id && d.verdict === "preempted")).toMatchObject(
      { reason: "superseded" },
    );
    expect(r.arbiter.queued()).toHaveLength(0);
  });

  it("someone addressing her preempts her own wishes waiting there", async () => {
    const r = rig();
    r.host.busy.add("discord:g:c1");
    await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE }));
    await r.arbiter.submit(impulse(r.clock, { source: "followup", context: HERE }));
    r.arbiter.turnFocus({
      turn: "t-owen",
      context: HERE,
      reason: "addressed",
      phase: "generating",
      addressed_by: ["Owen"],
      addressed_accounts: [acct("owen")],
      focus: [],
      background: [],
      restarts: 0,
      started_at: "",
      updated_at: "",
    });
    expect(r.arbiter.queued().map((i) => i.source)).toEqual(["followup"]);
  });

  it("the same coalesce key merges (the newest wins)", async () => {
    const r = rig();
    r.host.busy.add("discord:g:c1");
    const a = impulse(r.clock, { source: "game", context: HERE, coalesce_key: "comment" });
    const b = impulse(r.clock, { source: "game", context: HERE, coalesce_key: "comment" });
    await r.arbiter.submit(a);
    await r.arbiter.submit(b);
    expect(r.arbiter.queued().map((i) => i.id)).toEqual([b.id]);
    const merged = payloads<ArbiterDecision>(r.events, ARBITER_DECISION_TOPIC).find(
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
    const last = payloads<ArbiterDecision>(r.events, ARBITER_DECISION_TOPIC).at(-1);
    expect(last).toMatchObject({ impulse: short.id, verdict: "expired" });
  });
});

describe("ledger", () => {
  it("every block is recorded with its reason; limits show what applies", async () => {
    const r = rig({ max_per_day: 5, min_gap_secs: 0, gap_text_secs: 600 });
    await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE, hint: "週末要幹嘛" }));
    const blocked = await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE }));
    expect(blocked.verdict).toBe("rejected");
    const entries = payloads<LedgerEntry>(r.events, LEDGER_TOPIC);
    const denied = entries.filter((e) => e.outcome === "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.detail).toMatch(/^cooldown: /);
    expect(denied[0]?.self_initiated).toBe(true);
    const view = r.arbiter.ledger(HERE);
    expect(view.limits.initiatives_today).toBe(1);
    expect(view.limits.initiative_cap).toBe(5);
    expect(view.limits.next_initiative_at).toBe(new Date(T0 + 10 * MIN).toISOString());
    // Elsewhere she may start now.
    expect(r.arbiter.ledger(THERE).limits.next_initiative_at).toBeNull();
    expect(view.entries[0]?.context).toEqual(HERE);
  });

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

  it("a topic nobody picked up: topic_ignored, the streak and the backoff", async () => {
    const r = rig({ min_gap_secs: 0, gap_text_secs: 600, reply_window_text_secs: 600 });
    const d = await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE }));
    const turn = d.turn as string;
    r.arbiter.turnCompleted(turn, HERE, "欸你們週末要幹嘛");
    r.arbiter.turnOutcome(outcome(turn, HERE, "sent"));
    r.clock.advance(11 * MIN);
    await r.arbiter.tick();
    const ignored = payloads<AffectEvent>(r.events, AFFECT_EVENT_TOPIC);
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ kind: "topic_ignored", context: HERE });
    expect(ignored[0]?.detail).toContain("週末要幹嘛");
    const view = r.arbiter.ledger(HERE);
    expect(view.limits.unanswered_streak).toBe(1);
    expect(view.unanswered.map((t) => t.text)).toEqual(["欸你們週末要幹嘛"]);
    // The gap doubled: 20 minutes after her start, with the reason "unanswered" past the base.
    const again = await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE }));
    expect(again).toMatchObject({ verdict: "rejected", reason: "unanswered" });
    expect(Date.parse(again.retry_at as string)).toBe(T0 + 20 * MIN);
    expect(again.detail).toContain("連續 1 次沒人接");
  });

  it("someone answering resolves the topic and resets the backoff", async () => {
    const r = rig({ min_gap_secs: 0 });
    const d = await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE }));
    const turn = d.turn as string;
    r.arbiter.turnCompleted(turn, HERE, "有人在嗎");
    r.arbiter.turnOutcome(outcome(turn, HERE, "sent"));
    r.clock.advance(MIN);
    // Someone else's turn that answers her.
    r.arbiter.turnOutcome(outcome("t2", HERE, "silence", "reply_to_her"));
    r.clock.advance(20 * MIN);
    await r.arbiter.tick();
    expect(payloads(r.events, AFFECT_EVENT_TOPIC)).toHaveLength(0);
    const mine = r.arbiter.ledger(HERE).entries.find((e) => e.turn === turn);
    expect(mine).toMatchObject({ outcome: "ok" });
  });

  it("her turn that stayed silent is no raised topic", async () => {
    const r = rig({ min_gap_secs: 0 });
    const d = await r.arbiter.submit(impulse(r.clock, { source: "plan", context: HERE }));
    r.arbiter.turnCompleted(d.turn as string, HERE, "");
    r.arbiter.turnOutcome(outcome(d.turn as string, HERE, "silence"));
    r.clock.advance(20 * MIN);
    await r.arbiter.tick();
    expect(payloads(r.events, AFFECT_EVENT_TOPIC)).toHaveLength(0);
    expect(r.arbiter.ledger(HERE).limits.unanswered_streak).toBe(0);
  });

  it("an announcement nobody answers never raises the streak", async () => {
    const r = rig();
    const d = await r.arbiter.submit(impulse(r.clock, { source: "song", context: HERE }));
    r.arbiter.turnCompleted(d.turn as string, HERE, "我要唱下一首囉");
    r.arbiter.turnOutcome(outcome(d.turn as string, HERE, "sent"));
    r.clock.advance(30 * MIN);
    await r.arbiter.tick();
    expect(payloads(r.events, AFFECT_EVENT_TOPIC)).toHaveLength(0);
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
