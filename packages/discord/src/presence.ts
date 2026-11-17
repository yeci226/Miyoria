// Presence, voice state and member mapping (docs/design/autonomy.md §3). Like mapping.ts, the
// inputs are structural subsets of the discord.js classes so tests use plain objects.
//
// The bridge publishes the results as `platform.presence` / `platform.voice_state` /
// `platform.member` events for the `world` module. Presence of someone who opted out
// (`/me privacy presence:off`) is dropped before it reaches the bus (`PresencePrivacy`).

import {
  type ActivityKind,
  type MemberUpdate,
  type PresenceActivity,
  type PresenceStatus,
  type PresenceUpdate,
  toTimestamp,
  type VoiceStateUpdate,
} from "@miyoria/types";
import { ActivityType } from "discord.js";
import { account, displayName, PLATFORM, type UserLike } from "./mapping.js";

/** Longest text kept from an activity field (names and statuses are untrusted). */
export const MAX_ACTIVITY_TEXT = 128;
/** Activities kept per presence. */
export const MAX_ACTIVITIES = 5;

export interface ActivityLike {
  name: string;
  type: ActivityType;
  details?: string | null;
  state?: string | null;
  url?: string | null;
  timestamps?: { start?: Date | null } | null;
  emoji?: { name?: string | null } | null;
}

/** The member part of a presence / voice state (nickname and user). */
export interface MemberPartLike {
  nickname?: string | null;
  user?: UserLike | null;
}

export interface PresenceLike {
  userId: string;
  guild: { id: string } | null;
  status: string;
  activities: readonly ActivityLike[];
  user?: UserLike | null;
  member?: MemberPartLike | null;
}

export interface VoiceStateLike {
  id: string;
  guild: { id: string };
  channelId: string | null;
  channel?: { name: string } | null;
  selfMute?: boolean | null;
  selfDeaf?: boolean | null;
  serverMute?: boolean | null;
  serverDeaf?: boolean | null;
  selfVideo?: boolean | null;
  streaming?: boolean | null;
  member?: MemberPartLike | null;
}

export interface GuildMemberLike {
  id: string;
  guild: { id: string };
  nickname?: string | null;
  user?: UserLike | null;
}

/** Trims, drops control characters and limits the length; empty becomes `null`. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (text === "") return null;
  const chars = [...text];
  return chars.length > MAX_ACTIVITY_TEXT ? `${chars.slice(0, MAX_ACTIVITY_TEXT).join("")}…` : text;
}

export function presenceStatus(raw: string): PresenceStatus {
  switch (raw) {
    case "online":
    case "idle":
    case "dnd":
      return raw;
    default:
      // `invisible` is reported to others as offline.
      return "offline";
  }
}

function activityKind(type: ActivityType): ActivityKind | null {
  switch (type) {
    case ActivityType.Playing:
      return "playing";
    case ActivityType.Streaming:
      return "streaming";
    case ActivityType.Listening:
      return "listening";
    case ActivityType.Watching:
      return "watching";
    case ActivityType.Competing:
      return "competing";
    case ActivityType.Custom:
      return "custom";
    default:
      return null;
  }
}

export function activity(a: ActivityLike): PresenceActivity | null {
  const kind = activityKind(a.type);
  if (kind === null) return null;
  const start = a.timestamps?.start ?? null;
  if (kind === "custom") {
    return {
      type: "custom",
      name: cleanText(a.state) ?? "",
      details: cleanText(a.emoji?.name),
      state: null,
      started_at: null,
      url: null,
    };
  }
  return {
    type: kind,
    name: cleanText(a.name) ?? "",
    details: cleanText(a.details),
    state: cleanText(a.state),
    started_at: start ? toTimestamp(start) : null,
    url: kind === "streaming" ? cleanText(a.url) : null,
  };
}

function nameOf(id: string, member: MemberPartLike | null | undefined, user?: UserLike | null) {
  const u = user ?? member?.user ?? null;
  return u ? displayName(u, member?.nickname ?? null) : id;
}

/** `null` for DM presences (no guild). */
export function presenceUpdate(p: PresenceLike, initial: boolean): PresenceUpdate | null {
  if (p.guild === null) return null;
  const user = p.user ?? p.member?.user ?? null;
  const activities: PresenceActivity[] = [];
  for (const a of p.activities) {
    const mapped = activity(a);
    if (mapped) activities.push(mapped);
    if (activities.length >= MAX_ACTIVITIES) break;
  }
  return {
    platform: PLATFORM,
    guild: p.guild.id,
    account: account(p.userId),
    display_name: nameOf(p.userId, p.member, user),
    is_bot: user?.bot ?? false,
    status: presenceStatus(p.status),
    activities,
    initial,
  };
}

export function voiceStateUpdate(v: VoiceStateLike, initial: boolean): VoiceStateUpdate {
  const user = v.member?.user ?? null;
  return {
    platform: PLATFORM,
    guild: v.guild.id,
    account: account(v.id),
    display_name: nameOf(v.id, v.member),
    is_bot: user?.bot ?? false,
    channel: v.channelId,
    channel_name: v.channelId === null ? null : cleanText(v.channel?.name),
    self_mute: v.selfMute ?? false,
    self_deaf: v.selfDeaf ?? false,
    server_mute: v.serverMute ?? false,
    server_deaf: v.serverDeaf ?? false,
    video: v.selfVideo ?? false,
    streaming: v.streaming ?? false,
    initial,
  };
}

export function memberUpdate(m: GuildMemberLike, left: boolean): MemberUpdate {
  return {
    platform: PLATFORM,
    guild: m.guild.id,
    account: account(m.id),
    display_name: nameOf(m.id, m, m.user),
    is_bot: m.user?.bot ?? false,
    left,
  };
}
