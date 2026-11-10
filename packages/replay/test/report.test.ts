// The report's measures on a hand-made run: what counts as answered, as the right focus, as a
// block of her own, and as residual activity state.

import type { EventBus } from "@miyoria/kernel";
import {
  type ContextKey,
  customEvent,
  type Envelope,
  type Event,
  type TurnOutcome,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { ReplaySink } from "../src/fakes.js";
import { buildReport, type ReplayEntry, type ReplayRun, ScriptedLlm } from "../src/index.js";

const VOICE: ContextKey = { platform: "t", scope: "g", channel: "v", kind: "voice" };
const AT = toTimestamp(Date.UTC(2026, 10, 3, 6));

function utterance(id: string, who: string, text: string): ReplayEntry {
  return {
    at: AT,
    source: "voice",
    event: {
      type: "voice_utterance",
      data: {
        id,
        context: VOICE,
        speaker: { account: { platform: "t", id: who }, display_name: who, is_bot: false },
        text,
        language: "zh",
        emotion: null,
        audio_events: [],
        started_at: AT,
        ended_at: AT,
        asr_ms: 1,
      },
    },
  };
}

function env(event: Event): Envelope {
  return { id: "e", ts: AT, source: "agent", causation: null, correlation: null, event };
}

function outcome(turn: string, outcome: TurnOutcome, focus: string[], background: string[] = []) {
  const refs = (ids: string[]) => ids.map((id) => ({ context: VOICE, id }));
  return [
    env(
      customEvent("agent.turn.focus", {
        turn,
        context: VOICE,
        reason: "addressed",
        phase: "done",
        addressed_by: [],
        addressed_accounts: [],
        focus: refs(focus),
        background: refs(background),
        restarts: 0,
        started_at: AT,
        updated_at: AT,
      } as never),
    ),
    env(
      customEvent("agent.turn.outcome", {
        turn,
        context: VOICE,
        reason: "addressed",
        outcome,
        addressed_by: [],
        focus: refs(focus),
        restarts: 0,
        reasoning: null,
        latency_ms: null,
        at: AT,
      } as never),
    ),
  ];
}

function decision(impulse: string, source: string, verdict: string, reason: string | null) {
  return env(
    customEvent("arbiter.decision", {
      impulse,
      source,
      verdict,
      reason,
      detail: reason ?? "",
      retry_at: null,
      merged_into: null,
      turn: null,
      task: null,
      at: AT,
    }),
  );
}

function run(events: Envelope[], inputs: ReplayEntry[]): ReplayRun {
  return {
    name: "t",
    names: ["Miyoria", "米優"],
    selfAccounts: [],
    inputs,
    events,
    sink: new ReplaySink({ publish: () => undefined } as unknown as EventBus, () => 0),
    llm: new ScriptedLlm(),
    mouth: null,
    activity: null,
    durationMs: 1000,
  };
}

describe("report", () => {
  it("counts a call answered only when a sent turn had it in focus", () => {
    const inputs = [
      utterance("u1", "owen", "米優你覺得呢"),
      utterance("u2", "ming", "對"),
      utterance("u3", "owen", "米優,唱歌嗎"),
      utterance("u4", "hua", "米優在嗎"),
    ];
    const r = buildReport(
      run(
        [
          // Answered Owen, with Ming's 「對」 lumped into the focus: answered, but wrong focus.
          ...outcome("t1", { type: "sent", parts: 1 }, ["u1", "u2"]),
          // Cancelled: not answered.
          ...outcome("t2", { type: "cancelled", cause: "input", by: "ming" }, ["u3"]),
          // Answered someone else while Hua's call sat in the background: wrong focus.
          ...outcome("t3", { type: "sent", parts: 1 }, ["u2"], ["u4"]),
        ],
        inputs,
      ),
    );
    expect(r.voice_direct_speak_rate).toEqual({ num: 1, den: 3, rate: 0.333 });
    expect(r.focus_correct_rate).toEqual({ num: 0, den: 2, rate: 0 });
    expect(r.cancelled_by).toEqual({ input: 1 });
    expect(r.outcomes).toEqual({ sent: 2, cancelled: 1 });
  });

  it("measures her own blocked impulses by their last decision", () => {
    const r = buildReport(
      run(
        [
          decision("i1", "plan", "deferred", "busy"),
          decision("i1", "plan", "accepted", null),
          decision("i2", "agenda", "rejected", "unanswered"),
          decision("i3", "song", "rejected", "quiet_hours"),
        ],
        [],
      ),
    );
    expect(r.arbiter.self_initiated_block_rate).toEqual({ num: 1, den: 2, rate: 0.5 });
    expect(r.arbiter.blocked_by_reason).toEqual({ busy: 1, unanswered: 1, quiet_hours: 1 });
  });
});
