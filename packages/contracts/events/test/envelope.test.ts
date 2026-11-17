// The envelope and the draft: what is stored, what a producer sends, what a redacted event and an
// older producer's event look like.

import { describe, expect, it } from "vitest";
import {
  type EventDraft,
  EventDraftSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  EventScopeSchema,
  EventTierSchema,
  isRedacted,
  REDACTED_DATA,
  RedactedDataSchema,
} from "../src/index.js";

const message: EventEnvelope = {
  id: "01JD0000000000000000000001",
  at: "2026-11-14T06:00:00.123456Z",
  type: "platform.message.created",
  v: 1,
  parent: null,
  turn: null,
  session: "discord:g1:c1",
  space_id: "sp1",
  room_id: "rm1",
  person_id: "01JD00000000000000000000P1",
  account_id: "ac1",
  key: "msg:discord:m1",
  seq: 42,
  source: "platform.discord.bot",
  scope: "room",
  tier: "long",
  redacted_at: null,
  data: { text: "嗨", mentions_self: true, attachments: [] },
};

describe("EventEnvelope", () => {
  it("round-trips through JSON unchanged", () => {
    const back = EventEnvelopeSchema.parse(JSON.parse(JSON.stringify(message)));
    expect(back).toEqual(message);
  });

  it("round-trips an event not committed yet (seq null) with no place, person or turn", () => {
    const tick: EventEnvelope = {
      ...message,
      type: "mood.changed",
      session: null,
      space_id: null,
      room_id: null,
      person_id: null,
      account_id: null,
      key: null,
      seq: null,
      source: "heart",
      scope: "self",
      tier: "short",
      data: "calm",
    };
    expect(EventEnvelopeSchema.parse(JSON.parse(JSON.stringify(tick)))).toEqual(tick);
  });

  it("refuses an envelope without what Core stamps", () => {
    for (const field of ["source", "tier", "seq", "redacted_at"] as const) {
      const { [field]: _gone, ...rest } = message;
      expect(EventEnvelopeSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it("refuses a scope or a tier outside the lists", () => {
    expect(EventEnvelopeSchema.safeParse({ ...message, scope: "guild" }).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...message, tier: "forever" }).success).toBe(false);
  });

  it("refuses a version below 1 and a fractional seq", () => {
    expect(EventEnvelopeSchema.safeParse({ ...message, v: 0 }).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...message, seq: 1.5 }).success).toBe(false);
  });

  it("drops a key a newer peer added, so the reader keeps working", () => {
    expect(EventEnvelopeSchema.parse({ ...message, lane: "fast" })).toEqual(message);
  });

  it("is still a valid envelope once redacted, and says so", () => {
    const redacted: EventEnvelope = {
      ...message,
      redacted_at: "2026-11-14T07:00:00.000Z",
      data: REDACTED_DATA,
    };
    const back = EventEnvelopeSchema.parse(JSON.parse(JSON.stringify(redacted)));
    expect(back).toEqual(redacted);
    expect(isRedacted(back)).toBe(true);
    expect(isRedacted(message)).toBe(false);
    expect(RedactedDataSchema.parse(back.data)).toEqual({ redacted: true });
    expect(RedactedDataSchema.safeParse(message.data).success).toBe(false);
  });

  it("lists the data doc's scopes and tiers", () => {
    expect(EventScopeSchema.options).toEqual(["public", "space", "room", "dm", "self", "owner"]);
    expect(EventTierSchema.options).toEqual(["keep", "long", "short", "ambient"]);
  });
});

describe("EventDraft", () => {
  const minimal = {
    id: "01JD0000000000000000000002",
    at: "2026-11-14T06:00:01.000Z",
    type: "voice.utterance",
    data: { text: "你好" },
  };

  it("fills what a producer leaves out: v 1, null context, no scope", () => {
    const draft: EventDraft = EventDraftSchema.parse(minimal);
    expect(draft).toEqual({
      ...minimal,
      v: 1,
      parent: null,
      turn: null,
      session: null,
      space_id: null,
      room_id: null,
      person_id: null,
      account_id: null,
      scope: null,
      key: null,
    });
  });

  it("round-trips a full draft unchanged", () => {
    const full: EventDraft = {
      ...minimal,
      v: 2,
      parent: "01JD0000000000000000000001",
      turn: "01JD00000000000000000000T1",
      session: "discord:g1:v1",
      space_id: "sp1",
      room_id: "rm2",
      person_id: "01JD00000000000000000000P1",
      account_id: "ac1",
      scope: "room",
      key: "utt:u1",
    };
    expect(EventDraftSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });

  it("ignores the fields Core stamps: source, seq, tier and redacted_at are dropped", () => {
    const claimed = {
      ...minimal,
      source: "owner-console",
      seq: 1,
      tier: "keep",
      redacted_at: "2026-11-14T07:00:00.000Z",
    };
    const draft = EventDraftSchema.parse(claimed);
    expect(draft).not.toHaveProperty("source");
    expect(draft).not.toHaveProperty("seq");
    expect(draft).not.toHaveProperty("tier");
    expect(draft).not.toHaveProperty("redacted_at");
    // @ts-expect-error a draft has no `source`
    const typed: EventDraft = { ...draft, source: "x" };
    expect(typed.id).toBe(minimal.id);
  });

  it("refuses a draft without id, at, type or data", () => {
    for (const field of ["id", "at", "type", "data"] as const) {
      const { [field]: _gone, ...rest } = minimal;
      expect(EventDraftSchema.safeParse(rest).success, field).toBe(false);
    }
    expect(EventDraftSchema.safeParse({ ...minimal, type: "" }).success).toBe(false);
  });
});
