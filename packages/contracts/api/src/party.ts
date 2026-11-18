// The party games, read-only: the games running now (with players and scores) and how the last ones
// ended. Without the `party` module it is a `503` that names it, which is how the panel tells
// "party off" from "no games right now" (an empty list). Nothing here reaches a game: what a game
// keeps hidden (an answer, the turtle-soup bottom) is not in the snapshot.

import { z } from "zod";
import { ContextKeySchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

export const PartyPlayerViewSchema = z
  .object({
    /** Their display name; her own entry is `你`. */
    name: z.string(),
    her: z.boolean(),
    score: z.number(),
    /** In the voice channel now. */
    present: z.boolean(),
    /** Made a move the game took. */
    active: z.boolean(),
  })
  .meta({ id: "ApiPartyPlayerView" });
export type PartyPlayerView = z.output<typeof PartyPlayerViewSchema>;

/** A game going on. */
export const PartySessionViewSchema = z
  .object({
    id: z.string(),
    /** `song` or `soup`. */
    game: z.string(),
    title: z.string(),
    /** The voice channel it runs in, or the text channel of a turtle soup. */
    context: ContextKeySchema,
    /** The only state a listed game is in: one that ended moves to `recent`. */
    state: z.literal("running"),
    started_at: TimestampSchema,
    /** Points become coins at the end. */
    scored: z.boolean(),
    players: z.array(PartyPlayerViewSchema),
  })
  .meta({ id: "ApiPartySessionView" });
export type PartySessionView = z.output<typeof PartySessionViewSchema>;

/** A game that ended. */
export const PartyResultViewSchema = z
  .object({
    id: z.string(),
    game: z.string(),
    title: z.string(),
    context: ContextKeySchema,
    /** Why it ended: `done`, `host`, `stop`, `idle`, `empty`, `left`, `away`. */
    reason: z.string(),
    started_at: TimestampSchema,
    ended_at: TimestampSchema,
    scored: z.boolean(),
    /** The final standings, best first. */
    players: z.array(PartyPlayerViewSchema),
  })
  .meta({ id: "ApiPartyResultView" });
export type PartyResultView = z.output<typeof PartyResultViewSchema>;

export const PartySnapshotSchema = z
  .object({
    sessions: z.array(PartySessionViewSchema),
    /** Newest first. */
    recent: z.array(PartyResultViewSchema),
  })
  .meta({ id: "ApiPartySnapshot" });
export type PartySnapshot = z.output<typeof PartySnapshotSchema>;

export const party = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/party" })
  .output(PartySnapshotSchema);
