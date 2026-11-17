// defineEvent and the registry, with sample types of the test's own (the real payload schemas are
// a later step).

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_EVENT_TIER,
  defineEvent,
  EventDefinitionError,
  type EventEnvelope,
  EventEnvelopeSchema,
  EventMismatchError,
  type EventPayload,
  EventRegistry,
  eventDraft,
  REDACTED_DATA,
  readEventData,
} from "../src/index.js";

const ChatMessage = defineEvent({
  type: "chat.message",
  v: 1,
  data: z.object({
    text: z.string(),
    /** Added after the type was in use, so optional. */
    edited: z.boolean().optional(),
  }),
  tier: "long",
});

const ChatMessageV2 = defineEvent({
  type: "chat.message",
  v: 2,
  data: z.object({ text: z.string(), lang: z.string().nullable() }),
  tier: "long",
});

const AuditRoleGranted = defineEvent({
  type: "audit.roles.granted",
  v: 1,
  data: z.object({ actor: z.string(), target: z.string(), role: z.string() }),
  scope: "owner",
  tier: "keep",
});

const MoodTick = defineEvent({ type: "mood.changed", v: 1, data: z.string() });

const meta = { id: "01JD0000000000000000000003", at: "2026-11-14T06:00:02.000Z" };

/** What Core would make of a draft: the stamped fields added. */
function stamped(draft: ReturnType<typeof eventDraft>, overrides: Partial<EventEnvelope> = {}) {
  return EventEnvelopeSchema.parse({
    ...draft,
    seq: 7,
    source: "platform.discord.bot",
    scope: draft.scope ?? "room",
    tier: "long",
    redacted_at: null,
    ...overrides,
  });
}

describe("defineEvent", () => {
  it("keeps what it was given and fills the defaults", () => {
    expect(ChatMessage.type).toBe("chat.message");
    expect(ChatMessage.v).toBe(1);
    expect(ChatMessage.scope).toBeNull();
    expect(ChatMessage.tier).toBe("long");
    expect(MoodTick.tier).toBe(DEFAULT_EVENT_TIER);
    expect(AuditRoleGranted.scope).toBe("owner");
    expect(Object.isFrozen(ChatMessage)).toBe(true);
  });

  it("infers the payload type from the schema", () => {
    expectTypeOf<EventPayload<typeof ChatMessage>>().toEqualTypeOf<{
      text: string;
      edited?: boolean | undefined;
    }>();
    expectTypeOf<EventPayload<typeof MoodTick>>().toEqualTypeOf<string>();
    expectTypeOf(ChatMessage.type).toEqualTypeOf<"chat.message">();
  });

  it("refuses an empty type, whitespace in it, and a version below 1", () => {
    const data = z.string();
    expect(() => defineEvent({ type: "", v: 1, data })).toThrow(EventDefinitionError);
    expect(() => defineEvent({ type: "chat message", v: 1, data })).toThrow(EventDefinitionError);
    expect(() => defineEvent({ type: "chat.x", v: 0, data })).toThrow(EventDefinitionError);
    expect(() => defineEvent({ type: "chat.x", v: 1.5, data })).toThrow(EventDefinitionError);
  });
});

describe("EventRegistry", () => {
  const registry = () => new EventRegistry().register(ChatMessage, AuditRoleGranted, MoodTick);

  it("looks a definition up by type and version, the newest without a version", () => {
    const events = registry().register(ChatMessageV2);
    expect(events.get("chat.message", 1)).toBe(ChatMessage);
    expect(events.get("chat.message", 2)).toBe(ChatMessageV2);
    expect(events.get("chat.message")).toBe(ChatMessageV2);
    expect(events.get("chat.message", 3)).toBeNull();
    expect(events.get("chat.unknown")).toBeNull();
  });

  it("lists every definition by type, then version", () => {
    const events = new EventRegistry().register(MoodTick, ChatMessageV2, AuditRoleGranted);
    events.register(ChatMessage);
    expect(events.list()).toEqual([AuditRoleGranted, ChatMessage, ChatMessageV2, MoodTick]);
  });

  it("refuses a second definition of the same type and version", () => {
    const events = registry();
    const again = defineEvent({ type: "chat.message", v: 1, data: z.object({}) });
    expect(() => events.register(again)).toThrow(EventDefinitionError);
    expect(() => events.register(again)).toThrow("`chat.message` v1 is already registered");
    expect(events.get("chat.message", 1)).toBe(ChatMessage);
  });

  it("accepts the same definition registered twice", () => {
    const events = registry().register(ChatMessage);
    expect(events.list()).toHaveLength(3);
  });

  it("resolves the default scope and tier of a type", () => {
    const events = registry();
    expect(events.defaults("audit.roles.granted")).toEqual({ scope: "owner", tier: "keep" });
    expect(events.defaults("chat.message")).toEqual({ scope: null, tier: "long" });
    expect(events.defaults("mood.changed")).toEqual({ scope: null, tier: "short" });
  });

  it("gives a type nobody registered no default scope and the default tier", () => {
    expect(registry().defaults("platform.typing")).toEqual({
      scope: null,
      tier: DEFAULT_EVENT_TIER,
    });
  });

  it("takes the defaults from the newest version", () => {
    const events = new EventRegistry().register(
      MoodTick,
      defineEvent({ type: "mood.changed", v: 2, data: z.string(), tier: "ambient" }),
    );
    expect(events.defaults("mood.changed").tier).toBe("ambient");
  });
});

describe("eventDraft and readEventData", () => {
  it("builds a typed draft that parses as a draft and reads back", () => {
    const draft = eventDraft(ChatMessage, { text: "嗨" }, { ...meta, session: "discord:g1:c1" });
    expect(draft).toMatchObject({ type: "chat.message", v: 1, scope: null, parent: null });
    expect(draft.session).toBe("discord:g1:c1");
    expectTypeOf(draft.data).toEqualTypeOf<{ text: string; edited?: boolean | undefined }>();
    const envelope = stamped(draft);
    expect(readEventData(ChatMessage, envelope)).toEqual({ text: "嗨" });
    expect(readEventData(ChatMessage, draft)).toEqual({ text: "嗨" });
  });

  it("does not compile a payload of the wrong shape", () => {
    // @ts-expect-error `text` is a string
    const draft = eventDraft(ChatMessage, { text: 1 }, meta);
    expect(() => readEventData(ChatMessage, draft)).toThrow(z.ZodError);
  });

  it("reads an older producer's event that lacks a field its type added later", () => {
    const old = {
      ...meta,
      type: "chat.message",
      v: 1,
      parent: null,
      turn: null,
      session: "discord:g1:c1",
      space_id: null,
      room_id: null,
      person_id: null,
      account_id: null,
      key: null,
      seq: 3,
      source: "platform.discord.bot",
      scope: "room",
      tier: "long",
      redacted_at: null,
      data: { text: "早" },
    };
    const envelope = EventEnvelopeSchema.parse(old);
    expect(readEventData(ChatMessage, envelope)).toEqual({ text: "早" });
    expect(readEventData(ChatMessage, { ...envelope, data: { text: "早", edited: true } })).toEqual(
      { text: "早", edited: true },
    );
  });

  it("gives null for a redacted event instead of parsing its marker", () => {
    const envelope = stamped(eventDraft(ChatMessage, { text: "秘密" }, meta), {
      redacted_at: "2026-11-14T07:00:00.000Z",
      data: REDACTED_DATA,
    });
    expect(readEventData(ChatMessage, envelope)).toBeNull();
  });

  it("refuses an event of another type or version", () => {
    const envelope = stamped(eventDraft(ChatMessage, { text: "嗨" }, meta));
    expect(() => readEventData(AuditRoleGranted, envelope)).toThrow(EventMismatchError);
    expect(() => readEventData(ChatMessageV2, envelope)).toThrow(
      "expected event `chat.message` v2, got `chat.message` v1",
    );
  });

  it("throws when the payload does not fit the schema", () => {
    const envelope = stamped(eventDraft(ChatMessage, { text: "嗨" }, meta), { data: { text: 3 } });
    expect(() => readEventData(ChatMessage, envelope)).toThrow(z.ZodError);
  });
});
