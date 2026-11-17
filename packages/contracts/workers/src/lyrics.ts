import { z } from "zod";

// `POST /lyrics` takes a multipart body: see `WORKERS_LYRICS_FORM_FIELDS`.

/**
 * What the lookup knows about a song (`lyrics.hints_of`): the `hints` field of the request, JSON in
 * a form field. Keys without a value are left out. Everything in it comes from YouTube and is
 * untrusted.
 */
export const WorkersLyricsHintsSchema = z
  .object({
    /** The song's cache key. */
    key: z.string().optional(),
    /** The video's title as uploaded. */
    raw_title: z.string().optional(),
    title: z.string().optional(),
    artist: z.string().optional(),
    uploader: z.string().optional(),
    channel: z.string().optional(),
    /** The video's own music metadata. */
    track: z.string().optional(),
    meta_artist: z.string().optional(),
    alt_title: z.string().optional(),
    /** At most 1500 characters. */
    description: z.string().optional(),
    /** At most 15. */
    tags: z.array(z.string()).optional(),
    duration: z.number().optional(),
    url: z.string().optional(),
  })
  .meta({ id: "WorkersLyricsHints" });
export type WorkersLyricsHints = z.output<typeof WorkersLyricsHintsSchema>;

/** A found lyric (`lyrics.search`). */
export const WorkersLyricsResultSchema = z
  .object({
    /** `lrclib` or `netease`. */
    provider: z.string(),
    synced: z.boolean(),
    /** The LRC text, when it is synced. */
    lrc: z.string().nullable(),
    /** The text without times, when it is not. */
    plain: z.string().nullable(),
    track: z.string().nullable(),
    artist: z.string().nullable(),
    /** How the query was made: `metadata`, `title` or `llm`. */
    how: z.string(),
    /** How sure the match is, 0..1. */
    confidence: z.number(),
    matched: z.object({ query: z.string(), duration_s: z.number().nullable() }),
    /** What was checked (title and artist similarity, duration, the ASR spot check). */
    checks: z.record(z.string(), z.unknown()),
    /** Queries tried. */
    tried: z.number().int(),
    llm: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({ id: "WorkersLyricsResult" });
export type WorkersLyricsResult = z.output<typeof WorkersLyricsResultSchema>;

/** The answer to `POST /lyrics`: `result` is `null` when nothing was found. */
export const WorkersLyricsReplySchema = z
  .object({
    found: z.boolean(),
    result: WorkersLyricsResultSchema.nullable(),
  })
  .meta({ id: "WorkersLyricsReply" });
export type WorkersLyricsReply = z.output<typeof WorkersLyricsReplySchema>;

/** `GET /health` of the lyrics worker. Not the common shape: there is no `status`. */
export const WorkersLyricsHealthSchema = z
  .object({ ok: z.boolean() })
  .meta({ id: "WorkersLyricsHealth" });
export type WorkersLyricsHealth = z.output<typeof WorkersLyricsHealthSchema>;
