// Karaoke rooms (docs/design/karaoke.md 「做了什麼第四步」): up to eight people sing the same song at
// the same time, each in their own browser, while she hosts from her voice channel. A room is
// opened (paid) and joined on the member page by its code; a round starts for everyone at one
// moment of Core's clock. During a round each singer's microphone is streamed to Core and scored
// live (the official score); a singer is told only whether they are rising, dropping or holding,
// never anyone's rank or score, while spectators follow the whole board. Everyone sees the final
// ranking. Without the `karaoke` module these are a `503` that names it.
//
// Besides these JSON routes, a room has four member routes that are not on the table (see
// `packages/api/src/karaoke-routes.ts`): its event stream (`GET .../rooms/{code}/events`, Server-Sent
// Events: `KaraokeRoomEvent`), the clock (`POST .../rooms/{code}/clock`), a singer's microphone
// (`POST .../rooms/{code}/audio`) and a singer's detected pitch (`POST .../rooms/{code}/pitch`).

import { z } from "zod";
import { KaraokeSessionSchema, KaraokeSongViewSchema, KaraokeVoiceCheckSchema } from "./karaoke.js";
import { route } from "./route.js";

/** A room's code: six letters and digits people can read out (no 0/O, 1/I/L). */
export const KARAOKE_ROOM_CODE = /^[2-9A-HJKMNP-Z]{6}$/;

/**
 * `lobby` (people join, the opener picks the song), `countdown` (a round starts at `start_at`),
 * `singing`, `results` (the round's ranking; the opener picks the next song or closes), `closed`.
 */
export const KaraokeRoomStateSchema = z
  .enum(["lobby", "countdown", "singing", "results", "closed"])
  .meta({ id: "ApiKaraokeRoomState" });
export type KaraokeRoomState = z.output<typeof KaraokeRoomStateSchema>;

/** One person in a room. `id` is theirs within this room only. Names are untrusted. */
export const KaraokeRoomMemberSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.enum(["singer", "spectator"]),
    ready: z.boolean(),
    /** Opened the room (picks songs, starts, closes). */
    opener: z.boolean(),
    /** 0..7: their colour on the board and their pitch line. */
    color: z.number().int().min(0).max(7),
    /**
     * 「讓大家聽到我」 (step 5): they asked for their voice to be on the stream when they are the
     * round's one singer. Off by default and again for every round.
     */
    hear: z.boolean(),
    /**
     * 「不要播我的聲音」: when the room plays the leader's voice (`air.lead`), theirs is skipped (the
     * best-ranked singer who allows it is played instead).
     */
    skip: z.boolean(),
  })
  .meta({ id: "ApiKaraokeRoomMember" });
export type KaraokeRoomMember = z.output<typeof KaraokeRoomMemberSchema>;

/** What a room costs and pays, shown before anyone pays. */
export const KaraokeRoomTermsSchema = z
  .object({
    currency: z.string(),
    /** To open a room. */
    price: z.number().int(),
    /** To the winner of a round (two finishers at least, the official score). */
    prize: z.number().int(),
    /** To everyone who sings a round through. */
    finish: z.number().int(),
    /** Rounds one room may sing. */
    rounds: z.number().int(),
    max_singers: z.number().int(),
  })
  .meta({ id: "ApiKaraokeRoomTerms" });
export type KaraokeRoomTerms = z.output<typeof KaraokeRoomTermsSchema>;

/**
 * What her stream plays of a round (docs/design/karaoke.md 「做了什麼第五步」): the stream's
 * karaoke scene, not her voice connection (she is not the one singing). `backing`: the scene plays
 * the round's backing, `delay_ms` after the singers' start (one fixed delay per room, so the
 * relayed voice lines up with it). `lead`: the opener's 「播出第一名的歌聲」 (for rounds of two or
 * more singers). `relay`: whether a voice may go out (`allowed`, else `reason`), and, where this
 * person may know it, whose (`member`: the lone singer who asked for it, going out during the
 * round when `live`). A singer of a round with two or more singers never gets `member` or `live`
 * (it would tell them they lead); they see `lead` only.
 */
export const KaraokeRoomAirSchema = z
  .object({
    backing: z.boolean(),
    delay_ms: z.number().int(),
    lead: z.boolean(),
    /**
     * Singers Core counts for alone or not: the running round's singers during a countdown or a
     * round, else the members who would sing. A round of one singer is alone even when more
     * members chose to sing and were not ready.
     */
    singers: z.number().int(),
    relay: z.object({
      allowed: z.boolean(),
      reason: z.string().nullable(),
      member: z.string().nullable(),
      /** That voice is on the stream right now (during the round). */
      live: z.boolean(),
    }),
  })
  .meta({ id: "ApiKaraokeRoomAir" });
export type KaraokeRoomAir = z.output<typeof KaraokeRoomAirSchema>;

/** One singer's line of a round's final ranking. */
export const KaraokeRoomPlaceSchema = z
  .object({
    member: z.string(),
    name: z.string(),
    color: z.number().int(),
    /** 1 = first; equal totals share a rank. `null`: no result (did not finish, left). */
    rank: z.number().int().nullable(),
    total: z.number().nullable(),
    pitch: z.number().nullable(),
    stability: z.number().nullable(),
    rhythm: z.number().nullable(),
    expression: z.number().nullable(),
    /** `voice`: the official score; `estimate`: the browser's (預估), never a prize. */
    source: z.enum(["voice", "estimate"]).nullable(),
    /** Sang at least half of the song's voice. */
    finished: z.boolean(),
    checks: z.array(KaraokeVoiceCheckSchema),
    /** Coins paid for this round (prize and finishing). */
    coins: z.number().int(),
    winner: z.boolean(),
    /** Why there was no prize for them, a sentence (`null`: nothing to say). */
    note: z.string().nullable(),
  })
  .meta({ id: "ApiKaraokeRoomPlace" });
export type KaraokeRoomPlace = z.output<typeof KaraokeRoomPlaceSchema>;

/** A round's final ranking. */
export const KaraokeRoomResultSchema = z
  .object({
    round: z.number().int(),
    song: z.object({ id: z.string(), title: z.string(), artist: z.string().nullable() }),
    /** Still waiting for some official scores; the ranking is final when this is `false`. */
    settling: z.boolean(),
    places: z.array(KaraokeRoomPlaceSchema),
    /** Why the round paid no prize, a sentence (`null`: it did, or nothing to say). */
    note: z.string().nullable(),
  })
  .meta({ id: "ApiKaraokeRoomResult" });
export type KaraokeRoomResult = z.output<typeof KaraokeRoomResultSchema>;

/** A room as one person sees it. */
export const KaraokeRoomViewSchema = z
  .object({
    code: z.string(),
    state: KaraokeRoomStateSchema,
    /** Why it closed, a sentence; `null` while open. */
    closed_reason: z.string().nullable(),
    song: KaraokeSongViewSchema.nullable(),
    /** Semitones the backing is moved by, for everyone (one backing). */
    shift: z.number().int(),
    members: z.array(KaraokeRoomMemberSchema),
    /** This person: `null` when they are not in the room (they may join). */
    me: z
      .object({
        id: z.string(),
        role: z.enum(["singer", "spectator"]),
        opener: z.boolean(),
        /** They sing the round that is on (countdown or singing); `false`: they watch it. */
        singing: z.boolean(),
        /**
         * The round's files for them (signed links), while a round is on: their own singing when
         * `singing` (submit it at the end as alone), else one to watch with (never submitted).
         */
        session: KaraokeSessionSchema.nullable(),
      })
      .nullable(),
    /** The round now (1-based; 0 before the first) and how many the room may still start. */
    round: z.number().int(),
    rounds_left: z.number().int(),
    /** The round's start on Core's clock (ms since the epoch), during the countdown and singing. */
    start_at_ms: z.number().nullable(),
    /** The last round's ranking, once it is sung. */
    result: KaraokeRoomResultSchema.nullable(),
    terms: KaraokeRoomTermsSchema,
    /** What her voice channel carries (step 5). */
    air: KaraokeRoomAirSchema,
  })
  .meta({ id: "ApiKaraokeRoomView" });
export type KaraokeRoomView = z.output<typeof KaraokeRoomViewSchema>;

/** `GET /api/member/karaoke/rooms`: whether a room can be opened now, at what price. */
export const KaraokeRoomsSchema = z
  .object({
    /** A room can be opened now (she is in a voice channel, rooms are open). */
    available: z.boolean(),
    /** Why not, a sentence. */
    reason: z.string().nullable(),
    terms: KaraokeRoomTermsSchema,
    /** The person's balance; `null` when their wallet cannot be used. */
    balance: z.number().nullable(),
    /** The open room they are in, if any. */
    mine: z.string().nullable(),
  })
  .meta({ id: "ApiKaraokeRooms" });
export type KaraokeRooms = z.output<typeof KaraokeRoomsSchema>;

/** Body of `POST /api/member/karaoke/rooms` (opens and pays) and `.../rooms/{code}/song`. */
export const KaraokeRoomSongSchema = z
  .strictObject({
    song: z.string().min(1).max(64),
    shift: z.number().int().min(-6).max(6).default(0),
  })
  .meta({ id: "ApiKaraokeRoomSong" });
export type KaraokeRoomSong = z.input<typeof KaraokeRoomSongSchema>;

/** Body of `POST .../rooms/{code}/join`: sing (while seats are free and no round runs) or watch. */
export const KaraokeRoomJoinSchema = z
  .strictObject({ as: z.enum(["singer", "spectator"]).default("singer") })
  .meta({ id: "ApiKaraokeRoomJoin" });
export type KaraokeRoomJoin = z.input<typeof KaraokeRoomJoinSchema>;

/**
 * Body of `POST .../rooms/{code}/relay` (step 5), each field optional: `hear` a singer's own
 * 「讓大家聽到我」 (rounds they sing alone; off by default and again every round; can be turned off
 * mid-song), `skip` their own 「不要播我的聲音」 (rounds with two or more singers), `lead` the
 * opener's 「播出第一名的歌聲」 for the room (in the lobby or after a round). `member`: the opener
 * (or a panel admin) turns that person's voice off (`hear` off, `skip` on); never on.
 */
export const KaraokeRoomRelaySchema = z
  .strictObject({
    hear: z.boolean().optional(),
    skip: z.boolean().optional(),
    lead: z.boolean().optional(),
    member: z.string().max(32).optional(),
  })
  .meta({ id: "ApiKaraokeRoomRelay" });
export type KaraokeRoomRelay = z.input<typeof KaraokeRoomRelaySchema>;

/** Body of `POST .../rooms/{code}/ready`: their device's latency comes with it. */
export const KaraokeRoomReadySchema = z
  .strictObject({
    ready: z.boolean(),
    latency_ms: z.number().int().min(-500).max(1500).default(0),
    calibrated: z.boolean().default(false),
  })
  .meta({ id: "ApiKaraokeRoomReady" });
export type KaraokeRoomReady = z.input<typeof KaraokeRoomReadySchema>;

// ---- what the event stream carries (`GET .../rooms/{code}/events`) ---------------------------

/** One singer on the spectators' board. */
export const KaraokeBoardLineSchema = z
  .object({
    member: z.string(),
    name: z.string(),
    color: z.number().int(),
    rank: z.number().int(),
    total: z.number(),
    /** `voice`: scored live from their microphone; `estimate`: from their browser (預估). */
    source: z.enum(["voice", "estimate"]),
    /** Since the last board: up, down or the same place. */
    move: z.enum(["up", "down", "same"]),
    /**
     * Their pitch lately (the browser's detection), for the spectators' lanes: frames from `from`
     * at 50 Hz in song time, one byte a frame (`encodeTrack`), base64.
     */
    pitch: z.object({ from: z.number().int(), track: z.string() }).nullable(),
  })
  .meta({ id: "ApiKaraokeBoardLine" });
export type KaraokeBoardLine = z.output<typeof KaraokeBoardLineSchema>;

/**
 * A message of a room's event stream (SSE: `event:` is `type`, `data:` the whole message).
 *
 * - `room`: the room as this person sees it (on connect, and whenever it changes).
 * - `board`: the live ranking, every second while a round is sung; only to people who are not
 *   singing that round (the server never sends it to a singer's stream).
 * - `trend`: to a singer only, about themselves: `rising`, `dropping` or `holding`, and whether
 *   their live score comes from the stream (`voice`) or their browser (`estimate`).
 */
export const KaraokeRoomEventSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("room"), room: KaraokeRoomViewSchema }),
    z.object({
      type: z.literal("board"),
      round: z.number().int(),
      at_ms: z.number(),
      lines: z.array(KaraokeBoardLineSchema),
    }),
    z.object({
      type: z.literal("trend"),
      round: z.number().int(),
      trend: z.enum(["rising", "dropping", "holding"]),
      source: z.enum(["voice", "estimate"]),
    }),
  ])
  .meta({ id: "ApiKaraokeRoomEvent" });
export type KaraokeRoomEvent = z.output<typeof KaraokeRoomEventSchema>;

/** Body of `POST .../rooms/{code}/clock`, and its answer: one round trip of the clock sync. */
export const KaraokeClockSchema = z
  .strictObject({ t0: z.number() })
  .meta({ id: "ApiKaraokeClock" });
export const KaraokeClockReplySchema = z
  .object({ t0: z.number(), server_ms: z.number() })
  .meta({ id: "ApiKaraokeClockReply" });
export type KaraokeClockReply = z.output<typeof KaraokeClockReplySchema>;

/**
 * The answer to a singer's microphone chunk (`POST .../rooms/{code}/audio?at=&song_ms=&end=`, body:
 * µ-law 16 kHz mono): `live` keep streaming; `estimate` the stream is not scored now (keep the
 * recording for the end). `relay`: the chunks may go out on the stream this round (the singer
 * allows it), so keep sending them even when `stream` is `estimate`; stop only when both are off.
 */
export const KaraokeAudioReplySchema = z
  .object({ stream: z.enum(["live", "estimate"]), relay: z.boolean() })
  .meta({ id: "ApiKaraokeAudioReply" });
export type KaraokeAudioReply = z.output<typeof KaraokeAudioReplySchema>;

/** Body of `POST .../rooms/{code}/pitch`: the browser's detected pitch since `from` (50 Hz). */
export const KaraokePitchSchema = z
  .strictObject({ from: z.number().int().min(0), track: z.string().max(4_000) })
  .meta({ id: "ApiKaraokePitch" });
export type KaraokePitch = z.input<typeof KaraokePitchSchema>;

const member = () => route.meta({ audience: "member", permission: null, limited: true });
const code = z.object({ code: z.string().regex(KARAOKE_ROOM_CODE) });

/** The member's side of rooms: a session (by cookie), limited per account. */
export const karaokeRooms = {
  /** Whether a room can be opened, its price, their balance, and their open room. */
  overview: member()
    .route({ method: "GET", path: "/api/member/karaoke/rooms" })
    .output(KaraokeRoomsSchema),
  /** Opens a room with a ready song and pays for it (402 too few coins, 409 not now). */
  open: member()
    .route({ method: "POST", path: "/api/member/karaoke/rooms" })
    .input(z.object({ body: KaraokeRoomSongSchema }))
    .output(KaraokeRoomViewSchema),
  room: member()
    .route({ method: "GET", path: "/api/member/karaoke/rooms/{code}" })
    .input(z.object({ params: code }))
    .output(KaraokeRoomViewSchema),
  join: member()
    .route({ method: "POST", path: "/api/member/karaoke/rooms/{code}/join" })
    .input(z.object({ params: code, body: KaraokeRoomJoinSchema }))
    .output(KaraokeRoomViewSchema),
  leave: member()
    .route({ method: "POST", path: "/api/member/karaoke/rooms/{code}/leave" })
    .input(z.object({ params: code }))
    .output(KaraokeRoomViewSchema),
  ready: member()
    .route({ method: "POST", path: "/api/member/karaoke/rooms/{code}/ready" })
    .input(z.object({ params: code, body: KaraokeRoomReadySchema }))
    .output(KaraokeRoomViewSchema),
  /** The opener picks the round's song and key (in the lobby, or after a round). */
  song: member()
    .route({ method: "POST", path: "/api/member/karaoke/rooms/{code}/song" })
    .input(z.object({ params: code, body: KaraokeRoomSongSchema }))
    .output(KaraokeRoomViewSchema),
  /** A singer's 「讓大家聽到我」 / 「不要播我的聲音」, the opener's 「播出第一名的歌聲」, or cutting someone. */
  relay: member()
    .route({ method: "POST", path: "/api/member/karaoke/rooms/{code}/relay" })
    .input(z.object({ params: code, body: KaraokeRoomRelaySchema }))
    .output(KaraokeRoomViewSchema),
  /** The opener starts the round: a countdown to one moment for everyone. */
  start: member()
    .route({ method: "POST", path: "/api/member/karaoke/rooms/{code}/start" })
    .input(z.object({ params: code }))
    .output(KaraokeRoomViewSchema),
  /** The opener closes the room. */
  close: member()
    .route({ method: "POST", path: "/api/member/karaoke/rooms/{code}/close" })
    .input(z.object({ params: code }))
    .output(KaraokeRoomViewSchema),
};
