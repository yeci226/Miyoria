// What a platform reports besides messages (docs/design/v5-contracts.md §3, K12a): a connection of
// hers is up, someone is typing, someone reacted to a message, and what the platform says about
// people (presence, voice states, members). Each type is the bus topic it is published on, and its
// payload is that event's data. `platform.message.created` is a chat line (`chat.ts`).
//
// Tiers (v5-data §2.5): presence, voice states and member updates are ambient observations,
// folded after 14 days; typing is too. A reaction is a person's answer to a line, kept with the
// chat record (`long`), because feedback is derived from it again. A connection coming up is her
// own state (`self`), kept 90 days.

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  MessageRefSchema,
  PlatformIdSchema,
  TimestampSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** A connection of hers is up: `platform.ready`. */
export const PlatformReadySchema = z
  .object({
    platform: PlatformIdSchema,
    /** One of her own accounts; its messages are never input. */
    self_account: AccountRefSchema,
  })
  .meta({ id: "EventsPlatformReady" });
export type PlatformReadyData = z.output<typeof PlatformReadySchema>;

/** Someone started typing: `platform.typing`. */
export const PlatformTypingSchema = z
  .object({ context: ContextKeySchema, account: AccountRefSchema })
  .meta({ id: "EventsPlatformTyping" });
export type PlatformTypingData = z.output<typeof PlatformTypingSchema>;

/** A reaction added to or removed from a message: `platform.reaction`. */
export const PlatformReactionSchema = z
  .object({
    message: MessageRefSchema,
    account: AccountRefSchema,
    display_name: z.string().nullable(),
    emoji: z.string(),
    added: z.boolean(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsPlatformReaction" });
export type PlatformReactionData = z.output<typeof PlatformReactionSchema>;

export const PresenceStatusSchema = z
  .enum(["online", "idle", "dnd", "offline"])
  .meta({ id: "EventsPresenceStatus" });

export const PresenceActivityKindSchema = z
  .enum(["playing", "streaming", "listening", "watching", "competing", "custom"])
  .meta({ id: "EventsPresenceActivityKind" });

/**
 * One activity of a presence. `playing`: `name` the game; `listening`: `name` the app, on Spotify
 * `details` the track and `state` the artists; `streaming`: `details` the title and `url`;
 * `custom`: `name` the status text, `details` its emoji.
 */
export const PresenceActivitySchema = z
  .object({
    type: PresenceActivityKindSchema,
    name: z.string(),
    details: z.string().nullable(),
    state: z.string().nullable(),
    started_at: TimestampSchema.nullable(),
    url: z.string().nullable(),
  })
  .meta({ id: "EventsPresenceActivity" });

/** Someone's presence in a guild changed: `platform.presence`. */
export const PresenceUpdateSchema = z
  .object({
    platform: PlatformIdSchema,
    guild: z.string(),
    account: AccountRefSchema,
    display_name: z.string(),
    is_bot: z.boolean(),
    status: PresenceStatusSchema,
    activities: z.array(PresenceActivitySchema),
    /** Part of the snapshot sent after connecting, not a change. */
    initial: z.boolean(),
  })
  .meta({ id: "EventsPresenceUpdate" });
export type PresenceUpdateData = z.output<typeof PresenceUpdateSchema>;

/** Someone's voice state in a guild changed: `platform.voice_state`. */
export const VoiceStateUpdateSchema = z
  .object({
    platform: PlatformIdSchema,
    guild: z.string(),
    account: AccountRefSchema,
    display_name: z.string(),
    is_bot: z.boolean(),
    /** The voice channel; `null`: not in voice in this guild. */
    channel: z.string().nullable(),
    channel_name: z.string().nullable(),
    self_mute: z.boolean(),
    self_deaf: z.boolean(),
    server_mute: z.boolean(),
    server_deaf: z.boolean(),
    /** Camera on. */
    video: z.boolean(),
    /** Screen share (Go Live) on. */
    streaming: z.boolean(),
    initial: z.boolean(),
  })
  .meta({ id: "EventsVoiceStateUpdate" });
export type VoiceStateUpdateData = z.output<typeof VoiceStateUpdateSchema>;

/** A guild member was seen, changed or left: `platform.member`. */
export const MemberUpdateSchema = z
  .object({
    platform: PlatformIdSchema,
    guild: z.string(),
    account: AccountRefSchema,
    display_name: z.string(),
    is_bot: z.boolean(),
    /** They left the guild (or were removed). */
    left: z.boolean(),
  })
  .meta({ id: "EventsMemberUpdate" });
export type MemberUpdateData = z.output<typeof MemberUpdateSchema>;

export const PlatformReady = defineEvent({
  type: "platform.ready",
  v: 1,
  data: PlatformReadySchema,
  scope: "self",
  tier: "short",
});

export const PlatformTyping = defineEvent({
  type: "platform.typing",
  v: 1,
  data: PlatformTypingSchema,
  tier: "ambient",
});

export const PlatformReaction = defineEvent({
  type: "platform.reaction",
  v: 1,
  data: PlatformReactionSchema,
  tier: "long",
});

/** Guild-wide, so `space`. */
export const PlatformPresence = defineEvent({
  type: "platform.presence",
  v: 1,
  data: PresenceUpdateSchema,
  scope: "space",
  tier: "ambient",
});

export const PlatformVoiceState = defineEvent({
  type: "platform.voice_state",
  v: 1,
  data: VoiceStateUpdateSchema,
  scope: "space",
  tier: "ambient",
});

/** Mostly the snapshot after connecting; a join or a leave is rare beside it. */
export const PlatformMember = defineEvent({
  type: "platform.member",
  v: 1,
  data: MemberUpdateSchema,
  scope: "space",
  tier: "ambient",
});

/** Every platform type besides the chat line. */
export const PLATFORM_EVENTS = [
  PlatformReady,
  PlatformTyping,
  PlatformReaction,
  PlatformPresence,
  PlatformVoiceState,
  PlatformMember,
] as const;
