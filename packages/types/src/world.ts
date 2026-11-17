// Perception (docs/design/autonomy.md §3): what platforms report about people (presence, voice
// states, members) and the `WorldState` service that turns it into a queryable snapshot.
//
// Platform modules publish `Events.PlatformPresence`, `Events.PlatformVoiceState` and
// `Events.PlatformMember` with the payloads below; the `world` module consumes them and publishes
// `Events.WorldSalient` for changes worth her attention.

import type {
  MemberUpdateData,
  PresenceUpdateData,
  SalientEventData,
  VoiceStateUpdateData,
} from "@miyoria/contracts/events";
import type { PersonId, PlatformId } from "./ids.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

export type ActivityKind =
  | "playing"
  | "streaming"
  | "listening"
  | "watching"
  | "competing"
  | "custom";

/**
 * One activity of a presence. Field use per kind:
 *
 * * `playing`: `name` = game, `details` / `state` = what the game reports.
 * * `listening`: `name` = app (`"Spotify"`); on Spotify `details` = track, `state` = artist(s).
 * * `streaming`: `name` = platform, `details` = stream title, `url` = stream URL.
 * * `custom`: `name` = the custom status text (may be empty), `details` = its emoji.
 */
export interface PresenceActivity {
  type: ActivityKind;
  name: string;
  details: string | null;
  state: string | null;
  started_at: Timestamp | null;
  url: string | null;
}

// The payloads are contracts (`@miyoria/contracts/events`, `platform.ts`).
export type PresenceUpdate = PresenceUpdateData;

export type VoiceStateUpdate = VoiceStateUpdateData;

export type MemberUpdate = MemberUpdateData;

// ---- snapshot -------------------------------------------------------------------------------

/** Where someone is in voice. */
export interface VoiceSpot {
  platform: PlatformId;
  guild: string;
  channel: string;
  channel_name: string | null;
}

/** What she knows about one account right now. */
export interface PersonPresence {
  account: AccountRef;
  /** Resolved through the social module when known. */
  person: PersonId | null;
  display_name: string;
  /** `null`: no presence data (they opted out, or the platform reported none). */
  status: PresenceStatus | null;
  activities: PresenceActivity[];
  voice: VoiceSpot | null;
  /** When the current online stretch started (as far as she saw it). */
  online_since: Timestamp | null;
  updated_at: Timestamp;
}

export interface VoiceMember {
  account: AccountRef;
  person: PersonId | null;
  display_name: string;
  /** One of her own accounts. */
  is_self: boolean;
  /** Self or server muted. */
  muted: boolean;
  /** Self or server deafened. */
  deafened: boolean;
  video: boolean;
  streaming: boolean;
  /** When they joined this channel (as far as she saw it). */
  since: Timestamp;
}

export interface VoiceChannelState {
  platform: PlatformId;
  guild: string;
  channel: string;
  name: string | null;
  members: VoiceMember[];
  /**
   * How much is being said there (from transcribed utterances, so only known where she
   * listens); `null`/missing = unknown.
   */
  activity?: VoiceActivity | null;
}

/** Recent conversation in one voice channel. */
export interface VoiceActivity {
  /** Utterances of people within the voice activity window. */
  recent_utterances: number;
  /** Utterances per minute over the window. */
  per_minute: number;
  /** Their last utterance. */
  last_at: Timestamp | null;
  /** Seconds since `last_at` at the snapshot's time (`null`: none in the window). */
  secs_since_last: number | null;
  /** Display names of recent speakers, most recent first. */
  recent_speakers: string[];
  /** People are talking there right now: never a quiet channel. */
  lively: boolean;
  /** When she last spoke there. */
  her_last_at: Timestamp | null;
}

/** Recent activity of one text context. */
export interface ChannelActivity {
  context: ContextKey;
  /** Messages from people within the activity window. */
  recent_messages: number;
  /** Messages per minute over the activity window. */
  per_minute: number;
  last_at: Timestamp | null;
  /** Display names of recent authors, most recent first. */
  recent_authors: string[];
  /** A few frequent words of the recent messages (untrusted chat content). */
  topic: string[];
  /** Busy enough to count as lively. */
  lively: boolean;
  /** When she last spoke here. */
  her_last_at: Timestamp | null;
}

/** Her own situation. */
export interface HerStatus {
  /** The voice channel she is in. */
  voice: ContextKey | null;
  voice_name: string | null;
  /** Discord Go Live state (`"live"`, `"starting"`, ...); `null` = off. */
  golive: string | null;
  /** OBS is streaming. */
  streaming: boolean;
  /** Current OBS scene. */
  scene: string | null;
  /** Name of the game she is playing. */
  game: string | null;
  /**
   * The song she is singing (v2: from the ActivityManager). Optional only so that producers
   * built before it keep type-checking; the world module always sets it.
   */
  singing?: string | null;
}

export interface TimeContext {
  /** Local wall time, `YYYY-MM-DD HH:mm`. */
  local: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  weekend: boolean;
  /** `深夜` / `清晨` / `早上` / `中午` / `下午` / `傍晚` / `晚上`. */
  part_of_day: string;
  utc_offset_minutes: number;
}

export interface WorldSnapshot {
  at: Timestamp;
  time: TimeContext;
  her: HerStatus;
  /** People online or in voice, most interesting first. Opted-out people have no presence. */
  people: PersonPresence[];
  voice_channels: VoiceChannelState[];
  /** Text contexts with recent activity, busiest first. */
  channels: ChannelActivity[];
}

export interface WorldSummaryOptions {
  /** The context the summary is for (its channel is described first). */
  context?: ContextKey | null;
  maxPeople?: number;
}

/** Provided by the `world` module. Answers from memory. */
export interface WorldState {
  snapshot(): WorldSnapshot;
  person(account: AccountRef): PersonPresence | null;
  /** The first account of `person` she knows something about. */
  personById(person: PersonId): PersonPresence | null;
  /** Compact text for prompts (data, not instructions); empty when there is nothing to say. */
  summary(options?: WorldSummaryOptions): string;
}

export const WorldStateKey = serviceKey<WorldState>("WorldState");

// ---- salience -------------------------------------------------------------------------------

export type SalienceKind =
  /** Someone she cares about came online. */
  | "came_online"
  /** Someone she cares about joined a voice channel. */
  | "joined_voice"
  /** Someone started playing a game she is interested in. */
  | "started_game"
  /** A lively channel went quiet. */
  | "channel_quiet"
  /** She was mentioned in a context she has not been part of lately. */
  | "mentioned";

/** Payload of `world.salient` (contract: `SalientEventSchema` in @miyoria/contracts/events). */
export type SalientEvent = SalientEventData;

// ---- privacy --------------------------------------------------------------------------------

/**
 * Whether her platform modules may read someone's presence (`/me privacy`). Provided by the
 * `world` module; answers from memory. Platform modules drop the presence of accounts it
 * refuses before publishing it.
 */
export interface PresencePrivacy {
  /** The privacy records could be read; until then every presence is refused. */
  readonly loaded: boolean;
  presenceAllowed(account: AccountRef): boolean;
  /** Records `account`'s choice (`/me privacy presence`); opting out also drops what she knows. */
  setPresence(account: AccountRef, allowed: boolean): Promise<void>;
}

export const PresencePrivacyKey = serviceKey<PresencePrivacy>("PresencePrivacy");
