import { z } from "zod";

// ULID ids (26-character Crockford base32 strings, sortable by creation time).
export const EventIdSchema = z.string();
export type EventId = z.output<typeof EventIdSchema>;

/** Correlates every event, LLM call and action of one agent "turn" (perception to output). */
export const TurnIdSchema = z.string();
export type TurnId = z.output<typeof TurnIdSchema>;

export const ActionIdSchema = z.string();
export type ActionId = z.output<typeof ActionIdSchema>;

/** A cross-platform person. Several platform accounts can link to one person. */
export const PersonIdSchema = z.string();
export type PersonId = z.output<typeof PersonIdSchema>;

// Free-form string ids.
/** Stable module identifier, e.g. `"platform.discord.bot"` or `"agent"`. */
export const ModuleIdSchema = z.string();
export type ModuleId = z.output<typeof ModuleIdSchema>;

/** A profile bundles persona, LLM, voice and avatar, e.g. `"deepseek-chan"`. */
export const ProfileIdSchema = z.string();
export type ProfileId = z.output<typeof ProfileIdSchema>;

/** `"discord"`, later `"twitch"`, `"youtube"`, `"cli"` ... */
export const PlatformIdSchema = z.string();
export type PlatformId = z.output<typeof PlatformIdSchema>;

/**
 * A point in time as an RFC 3339 / ISO 8601 UTC string, e.g. `"2026-11-01T12:00:00.000Z"`.
 * This is how a time crosses every boundary (events, store records, API). Compare with
 * `Date.parse`, never as strings: other writers may use more fraction digits.
 */
export const TimestampSchema = z.string();
export type Timestamp = z.output<typeof TimestampSchema>;
