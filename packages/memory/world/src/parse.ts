// Validation of the bus payloads the world consumes. Extensions may publish under their own
// namespaces too, so payloads are parsed, never cast.

import type {
  JsonValue,
  MemberUpdate,
  PresenceActivity,
  PresenceUpdate,
  VoiceStateUpdate,
} from "@miyoria/types";
import { z } from "zod";

const Account = z.object({ platform: z.string(), id: z.string() });
const nullableString = z.string().nullable().catch(null);
const flag = z.boolean().catch(false);

const Activity = z.object({
  type: z.enum(["playing", "streaming", "listening", "watching", "competing", "custom"]),
  name: z.string().catch(""),
  details: nullableString,
  state: nullableString,
  started_at: nullableString,
  url: nullableString,
});

const Presence = z.object({
  platform: z.string(),
  guild: z.string(),
  account: Account,
  display_name: z.string(),
  is_bot: flag,
  status: z.enum(["online", "idle", "dnd", "offline"]),
  activities: z.array(z.unknown()).catch([]),
  initial: flag,
});

const VoiceState = z.object({
  platform: z.string(),
  guild: z.string(),
  account: Account,
  display_name: z.string(),
  is_bot: flag,
  channel: z.string().nullable(),
  channel_name: nullableString,
  self_mute: flag,
  self_deaf: flag,
  server_mute: flag,
  server_deaf: flag,
  video: flag,
  streaming: flag,
  initial: flag,
});

const Member = z.object({
  platform: z.string(),
  guild: z.string(),
  account: Account,
  display_name: z.string(),
  is_bot: flag,
  left: flag,
});

export function parsePresence(payload: JsonValue): PresenceUpdate | null {
  const parsed = Presence.safeParse(payload);
  if (!parsed.success) return null;
  const activities: PresenceActivity[] = [];
  for (const raw of parsed.data.activities) {
    const a = Activity.safeParse(raw);
    if (a.success) activities.push(a.data);
  }
  return { ...parsed.data, activities };
}

export function parseVoiceState(payload: JsonValue): VoiceStateUpdate | null {
  const parsed = VoiceState.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function parseMember(payload: JsonValue): MemberUpdate | null {
  const parsed = Member.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** `stage.status`: `{connected, streaming, scene, ...}`. */
export function parseStageStatus(
  payload: JsonValue,
): { connected: boolean; streaming: boolean; scene: string | null } | null {
  const parsed = z
    .object({ connected: flag, streaming: flag, scene: nullableString })
    .safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** `voice.golive`: `{platform, guild, state, ...}`. */
export function parseGolive(payload: JsonValue): { guild: string; state: string } | null {
  const parsed = z.object({ guild: z.string(), state: z.string() }).safeParse(payload);
  return parsed.success ? parsed.data : null;
}
