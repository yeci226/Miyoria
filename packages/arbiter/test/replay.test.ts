// A replay-style run (docs/design/v2-architecture.md §4 stage 2: "主動開話題被擋率 < 20%,被擋時
// 她知道原因"). A scripted day of people talking, songs, game commentary and busy moments goes
// through the Arbiter with fakes; her Plan is modelled as reading the ledger before it submits
// (it respects `next_initiative_at`, the daily cap, quiet hours and `waiting_for_response`) and
// is compared with a Plan that plans blind, as the old mind did.

import {
  ARBITER_DECISION_TOPIC,
  type ArbiterDecision,
  type ContextKey,
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
  type Rig,
  rig,
  textCtx,
  voiceCtx,
} from "./helpers.js";

/** Deterministic randomness. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PLACES: ContextKey[] = [textCtx("general"), textCtx("games"), voiceCtx("lounge")];
const PEOPLE = ["owen", "misaka", "kuro", "yui"];

interface Result {
  attempts: number;
  blocked: number;
  started: number;
  decisions: ArbiterDecision[];
  entries: LedgerEntry[];
}

/** 30 hours from 08:00 local, one step a minute. */
async function day(seeing: boolean, seed: number): Promise<Result> {
  const start = Date.UTC(2026, 10, 3, 0, 0, 0); // 08:00 local
  const r: Rig = rig({}, new ManualClock(start));
  const rand = lcg(seed);
  // Its own stream, so the rest of the day stays the same whatever people say.
  const talk = lcg(seed + 1);
  let attempts = 0;
  let blocked = 0;
  let started = 0;
  let nextPlan = start;
  const open = new Map<string, { context: ContextKey; at: number; answered: boolean }>();
  for (let minute = 0; minute < 30 * 60; minute++) {
    const now = r.clock.now();
    const hour = new Date(now + 8 * 60 * MIN).getUTCHours();
    const awake = hour >= 9 || hour < 1;
    // Busy moments: someone is mid-conversation with her for a minute or two.
    r.host.busy.clear();
    if (awake && rand() < 0.15) r.host.busy.add("discord:g:general");
    // People talk among themselves, about once every half hour in each place.
    for (const place of PLACES) {
      if (awake && talk() < 1 / 30) r.arbiter.heard(place, acct("yui"));
    }
    // Songs and game commentary (never her own initiative).
    if (awake && rand() < 0.03) {
      await r.arbiter.submit(
        impulse(r.clock, { source: "song", context: PLACES[2] as ContextKey }),
      );
    }
    if (awake && rand() < 0.05) {
      await r.arbiter.submit(
        impulse(r.clock, { source: "game", context: PLACES[1] as ContextKey, coalesce_key: "c" }),
      );
    }
    // Her Plan wakes every ~5 minutes ("很主動").
    if (now >= nextPlan) {
      nextPlan = now + 5 * MIN;
      const context = PLACES[Math.floor(rand() * PLACES.length)] as ContextKey;
      const person = rand() < 0.4 ? (PEOPLE[Math.floor(rand() * PEOPLE.length)] ?? null) : null;
      const view = r.arbiter.ledger(context);
      const limits = view.limits;
      const allowed =
        limits.next_initiative_at === null &&
        !limits.paused &&
        !limits.waiting_for_response &&
        !(limits.quiet_hours?.active ?? false) &&
        (limits.initiative_cap === null || limits.initiatives_today < limits.initiative_cap);
      // She wants to talk about half the time she wakes up.
      if (rand() < 0.5 && (allowed || !seeing)) {
        attempts += 1;
        const d = await r.arbiter.submit(
          impulse(r.clock, {
            source: "plan",
            context,
            account: person === null ? null : acct(person),
            ttlMs: 10 * MIN,
          }),
        );
        if (d.verdict === "rejected" || d.verdict === "expired" || d.verdict === "preempted") {
          blocked += 1;
        } else if (d.verdict === "accepted" && d.turn !== null) {
          started += 1;
          r.arbiter.turnCompleted(d.turn, context, "欸你們在幹嘛");
          r.arbiter.turnOutcome(outcome(d.turn, context, "sent", "initiative", now));
          open.set(d.turn, { context, at: now, answered: rand() < 0.4 });
        }
      } else if (!allowed && seeing) {
        // She sees when she may and wakes up then (her heartbeat follows the ledger).
        const next =
          limits.next_initiative_at === null ? null : Date.parse(limits.next_initiative_at);
        if (next !== null && next > nextPlan) nextPlan = next;
      }
    }
    // People answer some of what she raised, a few minutes later.
    for (const [turn, o] of open) {
      if (o.answered && now - o.at >= 3 * MIN) {
        r.arbiter.turnOutcome(outcome(`reply-${turn}`, o.context, "sent", "reply_to_her", now));
        open.delete(turn);
      } else if (now - o.at > 20 * MIN) {
        open.delete(turn);
      }
    }
    await r.arbiter.tick();
    r.clock.advance(MIN);
  }
  return {
    attempts,
    blocked,
    started,
    decisions: payloads<ArbiterDecision>(r.events, ARBITER_DECISION_TOPIC),
    entries: payloads<LedgerEntry>(r.events, LEDGER_TOPIC),
  };
}

describe("replay: a day of her own starts", () => {
  for (const seed of [1, 7, 42]) {
    it(`seeing the ledger, under 20% of her own starts are blocked (seed ${seed})`, async () => {
      const seen = await day(true, seed);
      expect(seen.attempts).toBeGreaterThan(10);
      expect(seen.started).toBeGreaterThan(5);
      expect(seen.blocked / seen.attempts).toBeLessThan(0.2);

      // Every "no" has a reason, both in the decision and in the ledger.
      for (const d of seen.decisions) {
        if (d.verdict === "accepted" || d.verdict === "merged") continue;
        expect(d.reason).not.toBeNull();
        expect(d.detail).not.toBe("");
      }
      for (const e of seen.entries.filter((x) => x.outcome === "denied")) {
        expect(e.detail ?? "").toMatch(/^[a-z_]+: ./);
      }
      // Announcements and commentary never count as hers.
      const theirs = seen.entries.filter((e) => e.source === "song" || e.source === "game");
      expect(theirs.length).toBeGreaterThan(0);
      expect(theirs.every((e) => !e.self_initiated)).toBe(true);

      // Planning blind (the old mind) hits the rules far more often.
      const blind = await day(false, seed);
      expect(blind.blocked / blind.attempts).toBeGreaterThan(seen.blocked / seen.attempts);
      expect(blind.blocked / blind.attempts).toBeGreaterThan(0.4);
    });
  }
});
