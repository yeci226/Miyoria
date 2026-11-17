// Her inner life, read-only: `GET /api/self` (drives, boredom, policy, agenda, mood, feelings) and
// `GET /api/world` (what she perceives). Changes go through her own decisions, not these routes.
// The emotions and the mood are shared with the affect routes and the telemetry.

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  PersonIdSchema,
  PlatformIdSchema,
  TimestampSchema,
} from "../../wire/src/index.js";
import { route } from "./route.js";

/** Her mood: derived from her emotions, drives and the time of day. */
export const MoodSchema = z
  .object({
    /** -1..1 */
    valence: z.number(),
    /** 0..1 */
    arousal: z.number(),
    /** 0..1 */
    energy: z.number(),
  })
  .meta({ id: "ApiMood" });
export type Mood = z.output<typeof MoodSchema>;

/**
 * `social`: wants to interact with people; `play`: wants to play a game; `attention`: wants to be
 * noticed; `rest`: wants to rest; `curiosity`: wants something new; `esteem`: wants to be
 * acknowledged; `hunger`: her appetite for 白飯 (tokens); `longing`: wants to be near her crush.
 */
export const DriveNameSchema = z
  .enum(["social", "play", "attention", "rest", "curiosity", "esteem", "hunger", "longing"])
  .meta({ id: "ApiDriveName" });
export type DriveName = z.output<typeof DriveNameSchema>;

/** Each 0..1. */
export const DrivesSchema = z
  .object({
    social: z.number(),
    play: z.number(),
    attention: z.number(),
    rest: z.number(),
    curiosity: z.number(),
    esteem: z.number(),
    hunger: z.number(),
    longing: z.number(),
  })
  .meta({ id: "ApiDrives" });
export type Drives = z.output<typeof DrivesSchema>;

/** Her discrete emotions (七情 and a few more), each 0..1 with its own decay. */
export const EmotionNameSchema = z
  .enum([
    "joy",
    "anger",
    "sorrow",
    "fear",
    "surprise",
    "disgust",
    "shy",
    "pride",
    "jealousy",
    "lonely",
    "missing",
    "gratitude",
    "guilt",
    "frustration",
  ])
  .meta({ id: "ApiEmotionName" });
export type EmotionName = z.output<typeof EmotionNameSchema>;

/** The emotions she feels toward one person. */
export const PersonEmotionNameSchema = z
  .enum(["missing", "jealousy", "gratitude", "resentment"])
  .meta({ id: "ApiPersonEmotionName" });
export type PersonEmotionName = z.output<typeof PersonEmotionNameSchema>;

/** One emotion she feels now. */
export const EmotionReadingSchema = z
  .object({
    name: EmotionNameSchema,
    /** 0..1, decayed to now. */
    intensity: z.number(),
    /** What last stirred it (short, zh-TW). */
    cause: z.string(),
    at: TimestampSchema,
    /** Who it is about, when someone. */
    person: PersonIdSchema.nullable(),
  })
  .meta({ id: "ApiEmotionReading" });
export type EmotionReading = z.output<typeof EmotionReadingSchema>;

/** What she lets show of what she feels. */
export const ShownEmotionSchema = z
  .object({
    /** The felt emotion it comes from. */
    from: EmotionNameSchema,
    /** The `<emo:…>` tag it shows as. */
    tag: z.string(),
    /** How it shows, in words. */
    style: z.string(),
    /** She hides what she feels. */
    masked: z.boolean(),
  })
  .meta({ id: "ApiShownEmotion" });
export type ShownEmotion = z.output<typeof ShownEmotionSchema>;

/** How talkative she wants to be in one scope (0 = silent, 1 = very chatty). */
export const TalkativenessSchema = z
  .object({
    level: z.number(),
    /** Expiry; `null`: until she changes it. */
    until: TimestampSchema.nullable(),
    /** Her reason, in her own words. */
    why: z.string(),
    set_at: TimestampSchema,
  })
  .meta({ id: "ApiTalkativeness" });
export type Talkativeness = z.output<typeof TalkativenessSchema>;

export const SelfPolicySchema = z
  .object({
    /** By scope: `*`, `voice`, `text`, `discord:<guild>`, or a context string. */
    talkativeness: z.record(z.string(), TalkativenessSchema),
    /** Willingness to start things on her own, 0..1. */
    initiative: z.number(),
    initiative_why: z.string(),
  })
  .meta({ id: "ApiSelfPolicy" });
export type SelfPolicy = z.output<typeof SelfPolicySchema>;

export const AgendaStatusSchema = z
  .enum(["open", "done", "expired", "dropped"])
  .meta({ id: "ApiAgendaStatus" });
export type AgendaStatus = z.output<typeof AgendaStatusSchema>;

/** Something she is doing or means to do. */
export const AgendaItemSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    why: z.string(),
    person: PersonIdSchema.nullable(),
    context: ContextKeySchema.nullable(),
    created_at: TimestampSchema,
    /** Earliest time it makes sense; `null`: any time. */
    due: TimestampSchema.nullable(),
    /** It no longer matters after this; `null`: never expires. */
    expires_at: TimestampSchema.nullable(),
    status: AgendaStatusSchema,
    /** When it was done, dropped or expired. */
    closed_at: TimestampSchema.nullable(),
    /** An action it needs failed: on hold until the situation changes (older records: none). */
    blocked: z
      .object({
        /** The capability that failed (`game.start`). */
        capability: z.string(),
        /** Why, in short (the action's error). */
        reason: z.string(),
        at: TimestampSchema,
      })
      .nullable()
      .optional(),
  })
  .meta({ id: "ApiAgendaItem" });
export type AgendaItem = z.output<typeof AgendaItemSchema>;

/** Her impression of a person (their heart row's), with the person's name. */
export const FeelingViewSchema = z
  .object({
    person: PersonIdSchema,
    text: z.string(),
    /** When their row last changed. */
    updated_at: TimestampSchema,
    display_name: z.string().nullable(),
  })
  .meta({ id: "ApiFeelingView" });
export type FeelingView = z.output<typeof FeelingViewSchema>;

/**
 * `GET /api/self`: her inner state and her impressions of people (newest first, from the heart's
 * rows). The emotions and what shows of them are there when the `self` module reports them.
 */
export const SelfViewSchema = z
  .object({
    at: TimestampSchema,
    /** From the `mood` module; `null` while it is not running. */
    mood: MoodSchema.nullable(),
    /** 0..1, rises when nothing happens. */
    boredom: z.number(),
    drives: DrivesSchema,
    policy: SelfPolicySchema,
    /** Open items first (by due time), then recently closed ones. */
    agenda: z.array(AgendaItemSchema),
    emotions: z.array(EmotionReadingSchema).optional(),
    shown: ShownEmotionSchema.nullable().optional(),
    feelings: z.array(FeelingViewSchema),
  })
  .meta({ id: "ApiSelfView" });
export type SelfView = z.output<typeof SelfViewSchema>;

// ---- the world ----------------------------------------------------------------------------

export const PresenceStatusSchema = z
  .enum(["online", "idle", "dnd", "offline"])
  .meta({ id: "ApiPresenceStatus" });
export type PresenceStatus = z.output<typeof PresenceStatusSchema>;

/** One activity of a presence (a game, a song on Spotify, a stream, a custom status). */
export const PresenceActivitySchema = z
  .object({
    type: z.enum(["playing", "streaming", "listening", "watching", "competing", "custom"]),
    name: z.string(),
    details: z.string().nullable(),
    state: z.string().nullable(),
    started_at: TimestampSchema.nullable(),
    url: z.string().nullable(),
  })
  .meta({ id: "ApiPresenceActivity" });
export type PresenceActivity = z.output<typeof PresenceActivitySchema>;

/** Where someone is in voice. */
export const VoiceSpotSchema = z
  .object({
    platform: PlatformIdSchema,
    guild: z.string(),
    channel: z.string(),
    channel_name: z.string().nullable(),
  })
  .meta({ id: "ApiVoiceSpot" });
export type VoiceSpot = z.output<typeof VoiceSpotSchema>;

/** What she knows about one account right now. */
export const PersonPresenceSchema = z
  .object({
    account: AccountRefSchema,
    /** Resolved through the social module when known. */
    person: PersonIdSchema.nullable(),
    display_name: z.string(),
    /** `null`: no presence data (they opted out, or the platform reported none). */
    status: PresenceStatusSchema.nullable(),
    activities: z.array(PresenceActivitySchema),
    voice: VoiceSpotSchema.nullable(),
    /** When the current online stretch started (as far as she saw it). */
    online_since: TimestampSchema.nullable(),
    updated_at: TimestampSchema,
  })
  .meta({ id: "ApiPersonPresence" });
export type PersonPresence = z.output<typeof PersonPresenceSchema>;

export const VoiceMemberSchema = z
  .object({
    account: AccountRefSchema,
    person: PersonIdSchema.nullable(),
    display_name: z.string(),
    /** One of her own accounts. */
    is_self: z.boolean(),
    /** Self or server muted. */
    muted: z.boolean(),
    /** Self or server deafened. */
    deafened: z.boolean(),
    video: z.boolean(),
    streaming: z.boolean(),
    /** When they joined this channel (as far as she saw it). */
    since: TimestampSchema,
  })
  .meta({ id: "ApiVoiceMember" });
export type VoiceMember = z.output<typeof VoiceMemberSchema>;

/** Recent conversation in one voice channel. */
export const VoiceActivitySchema = z
  .object({
    /** Utterances of people within the voice activity window. */
    recent_utterances: z.number(),
    /** Utterances per minute over the window. */
    per_minute: z.number(),
    /** Their last utterance. */
    last_at: TimestampSchema.nullable(),
    /** Seconds since `last_at` (`null`: none in the window). */
    secs_since_last: z.number().nullable(),
    /** Display names of recent speakers, most recent first. */
    recent_speakers: z.array(z.string()),
    /** People are talking there right now. */
    lively: z.boolean(),
    /** When she last spoke there. */
    her_last_at: TimestampSchema.nullable(),
  })
  .meta({ id: "ApiVoiceActivity" });
export type VoiceActivity = z.output<typeof VoiceActivitySchema>;

export const VoiceChannelStateSchema = z
  .object({
    platform: PlatformIdSchema,
    guild: z.string(),
    channel: z.string(),
    name: z.string().nullable(),
    members: z.array(VoiceMemberSchema),
    /** How much is being said there; `null` or missing: unknown. */
    activity: VoiceActivitySchema.nullable().optional(),
  })
  .meta({ id: "ApiVoiceChannelState" });
export type VoiceChannelState = z.output<typeof VoiceChannelStateSchema>;

/** A text context of the world snapshot, with its human name when the platform knows it. */
export const ChannelActivityViewSchema = z
  .object({
    context: ContextKeySchema,
    /** Messages from people within the activity window. */
    recent_messages: z.number(),
    /** Messages per minute over the activity window. */
    per_minute: z.number(),
    last_at: TimestampSchema.nullable(),
    /** Display names of recent authors, most recent first. */
    recent_authors: z.array(z.string()),
    /** A few frequent words of the recent messages (untrusted chat content). */
    topic: z.array(z.string()),
    /** Busy enough to count as lively. */
    lively: z.boolean(),
    /** When she last spoke here. */
    her_last_at: TimestampSchema.nullable(),
    label: z.string().nullable(),
  })
  .meta({ id: "ApiChannelActivityView" });
export type ChannelActivityView = z.output<typeof ChannelActivityViewSchema>;

/** Her own situation. */
export const HerStatusSchema = z
  .object({
    /** The voice channel she is in. */
    voice: ContextKeySchema.nullable(),
    voice_name: z.string().nullable(),
    /** Discord Go Live state (`live`, `starting`, ...); `null`: off. */
    golive: z.string().nullable(),
    /** OBS is streaming. */
    streaming: z.boolean(),
    /** Current OBS scene. */
    scene: z.string().nullable(),
    /** Name of the game she is playing. */
    game: z.string().nullable(),
    /** The song she is singing (the world module always sets it). */
    singing: z.string().nullable().optional(),
  })
  .meta({ id: "ApiHerStatus" });
export type HerStatus = z.output<typeof HerStatusSchema>;

export const TimeContextSchema = z
  .object({
    /** Local wall time, `YYYY-MM-DD HH:mm`. */
    local: z.string(),
    /** 0 = Sunday ... 6 = Saturday. */
    weekday: z.number(),
    weekend: z.boolean(),
    /** `深夜` / `清晨` / `早上` / `中午` / `下午` / `傍晚` / `晚上`. */
    part_of_day: z.string(),
    utc_offset_minutes: z.number(),
  })
  .meta({ id: "ApiTimeContext" });
export type TimeContext = z.output<typeof TimeContextSchema>;

/** `GET /api/world`: what she perceives right now. */
export const WorldViewSchema = z
  .object({
    at: TimestampSchema,
    time: TimeContextSchema,
    her: HerStatusSchema,
    /** People online or in voice, most interesting first. */
    people: z.array(PersonPresenceSchema),
    voice_channels: z.array(VoiceChannelStateSchema),
    /** Text contexts with recent activity, busiest first. */
    channels: z.array(ChannelActivityViewSchema),
  })
  .meta({ id: "ApiWorldView" });
export type WorldView = z.output<typeof WorldViewSchema>;

export const self = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/self" })
  .output(SelfViewSchema);

export const world = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/world" })
  .output(WorldViewSchema);
