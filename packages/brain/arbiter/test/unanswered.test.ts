// What counts as her starting to talk and as a person answering her (`unanswered.ts`), and an
// older saved ledger state.

import { type AnyEventDefinition, Events, eventEnvelope, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanResponse, LedgerSnapshotSchema, startsTalk } from "../src/index.js";
import { acct, impulse, ManualClock, T0, textCtx, voiceCtx } from "./helpers.js";

const ev = (definition: AnyEventDefinition, data: unknown) =>
  eventEnvelope("test", definition, data);

const VOICE = voiceCtx("v1");

afterEach(() => {
  vi.useRealTimers();
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

  const message = (who: string, isBot: boolean) =>
    ev(Events.PlatformMessageCreated, {
      id: { context: textCtx("c"), id: "m" },
      author: { account: acct(who), display_name: who, is_bot: isBot },
      text: "hi",
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(T0),
    });

  const utterance = (who: string, text: string, isBot = false) =>
    ev(Events.VoiceUtteranceEvent, {
      context: VOICE,
      speaker: { account: acct(who), display_name: who, is_bot: isBot },
      text,
    });
  const isSelf = (a: { id: string }): boolean => a.id === "her";

  it("humanResponse: not her, not bots, not silence, not people coming and going", () => {
    expect(humanResponse(message("her", false), isSelf)).toBeNull();
    expect(humanResponse(message("b", true), isSelf)).toBeNull();
    expect(humanResponse(utterance("her", "欸"), isSelf)).toBeNull();
    expect(humanResponse(utterance("b", "欸", true), isSelf)).toBeNull();
    expect(humanResponse(utterance("a", "   "), isSelf)).toBeNull();
    expect(
      humanResponse(ev(Events.VoiceParticipants, { context: VOICE, participants: [] }), isSelf),
    ).toBeNull();
  });
});

describe("the state survives a restart", () => {
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
