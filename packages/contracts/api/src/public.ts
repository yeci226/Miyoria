// The public side: what anyone may see, with no login. Nothing in these shapes points at a person,
// and the server strips whatever a response carries beyond them.

import { z } from "zod";
import { IssuedCardSchema } from "./member.js";
import { route } from "./route.js";
import { SpaceQuery } from "./shared.js";

/** What she is doing, as the public page says it. `offline`: the modules that know are stopped. */
export const PublicStateSchema = z
  .enum(["singing", "playing", "live", "in_voice", "idle", "offline"])
  .meta({ id: "ApiPublicState" });
export type PublicState = z.output<typeof PublicStateSchema>;

/** Today's aggregate numbers. */
export const PublicTodaySchema = z
  .object({ songs_sung: z.number(), hours_live: z.number(), hours_in_voice: z.number() })
  .meta({ id: "ApiPublicToday" });
export type PublicToday = z.output<typeof PublicTodaySchema>;

/** One local day of `PublicToday`, `date` as `YYYY-MM-DD`. */
export const PublicDaySchema = PublicTodaySchema.extend({ date: z.string() }).meta({
  id: "ApiPublicDay",
});
export type PublicDay = z.output<typeof PublicDaySchema>;

/** `GET /api/public/status`. */
export const PublicStatusSchema = z
  .object({
    state: PublicStateSchema,
    live: z.boolean(),
    in_voice: z.boolean(),
    /** The game id while she plays one. */
    game: z.string().nullable(),
    today: PublicTodaySchema,
    /** The last 14 local days, oldest first, today last. */
    days: z.array(PublicDaySchema),
  })
  .meta({ id: "ApiPublicStatus" });
export type PublicStatus = z.output<typeof PublicStatusSchema>;

/** A song on the public page. `title` is `null` until the worker found it, or if it was screened. */
export const PublicSongSchema = z
  .object({
    title: z.string().nullable(),
    artist: z.string().nullable(),
    duration_s: z.number().nullable(),
  })
  .meta({ id: "ApiPublicSong" });
export type PublicSong = z.output<typeof PublicSongSchema>;

/** `GET /api/public/songs`. Who asked for a song and what they typed stay out of it. */
export const PublicSongsSchema = z
  .object({
    playing: PublicSongSchema.nullable(),
    /** Still to come, in order. */
    upcoming: z.array(PublicSongSchema.extend({ ready: z.boolean() })),
    /** What she sang last, newest first. */
    recent: z.array(PublicSongSchema),
  })
  .meta({ id: "ApiPublicSongs" });
export type PublicSongs = z.output<typeof PublicSongsSchema>;

/** `GET /api/public/board`: only people who chose to be on it, by what they spent on her lately. */
export const PublicBoardSchema = z
  .object({
    entries: z.array(
      z.object({
        /** 1 for the top; the same spend shares a rank. */
        rank: z.number(),
        /** A display name; one moderation does not pass is shown as 匿名. */
        name: z.string(),
        /** Coins spent on her over the board's window. */
        spent: z.number(),
      }),
    ),
  })
  .meta({ id: "ApiPublicBoard" });
export type PublicBoard = z.output<typeof PublicBoardSchema>;

/**
 * `GET /api/public/card/{serial}`: the card, and the titles its holder chose to show others
 * (series titles, private unless they make one public); empty on an older member card.
 */
export const PublicCardSchema = IssuedCardSchema.extend({
  titles: z.array(z.string()),
}).meta({ id: "ApiPublicCard" });
export type PublicCard = z.output<typeof PublicCardSchema>;

export const publicView = {
  /** One body serves everyone for `cache_secs`; 429 with `Retry-After` past the rate limit. */
  status: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/public/status" })
    .output(PublicStatusSchema),
  /** What is playing, what is coming up, what she just sang. Same cache and limits as the status. */
  songs: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/public/songs" })
    // `?space=`: that server's songs (`404` for one she is not in); without it, the primary's.
    .input(z.object({ query: SpaceQuery }).optional())
    .output(PublicSongsSchema),
  /** The sponsor board. Same cache and limits as the status. */
  board: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/public/board" })
    .output(PublicBoardSchema),
  /**
   * Whether a card's serial checks out. Limited per client (`429`), never cached, and `404`
   * for a serial that is malformed or unknown. A voided card answers, with `voided_at` set.
   */
  card: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/public/card/{serial}" })
    .input(z.object({ params: z.object({ serial: z.string() }) }))
    .output(PublicCardSchema),
};
