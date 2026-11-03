// Discord-side plumbing around the selfbot client: login, name resolution, voice-state helpers.
import {
  Client,
  type Guild,
  type GuildMember,
  type User,
  type VoiceBasedChannel,
} from "@lng2004/discord.js-selfbot-v13";
import type { SpeakerInfo } from "./capture.js";
import type { Logger } from "./log.js";
import type { Participant } from "./protocol.js";

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Logs the self account in and resolves once the gateway is READY. */
export async function loginSelf(token: string, log: Logger): Promise<Client<true>> {
  const client = new Client();
  const ready = new Promise<void>((resolve) => client.once("ready", () => resolve()));
  await withTimeout(client.login(token), 60_000, "Discord login");
  await withTimeout(ready, 60_000, "Discord gateway READY");
  log.info(`logged in as ${client.user?.tag ?? "?"} (${client.user?.id ?? "?"})`);
  return client as Client<true>;
}

/** Guild nickname > global display name > username > id. */
export function displayNameFor(
  member: GuildMember | null | undefined,
  user: User | null | undefined,
  fallbackId: string,
): string {
  const u = user ?? member?.user ?? null;
  return member?.nickname || u?.globalName || u?.username || fallbackId;
}

/** Everyone currently in `channelId`, from the guild voice-state cache. */
export function listParticipants(guild: Guild, channelId: string, selfId: string): Participant[] {
  const out: Participant[] = [];
  for (const vs of guild.voiceStates.cache.values()) {
    if (vs.channelId !== channelId) continue;
    const member = vs.member;
    out.push({
      user_id: vs.id,
      display_name: displayNameFor(member, vs.user ?? member?.user ?? null, vs.id),
      is_self: vs.id === selfId,
      muted: vs.selfMute === true || vs.serverMute === true,
      deafened: vs.selfDeaf === true || vs.serverDeaf === true,
    });
  }
  return out;
}

/** Finds the voice channel `userId` is in, if any (cache first, then a member fetch). */
export async function findUserVoiceChannel(guild: Guild, userId: string): Promise<string | null> {
  const cached = guild.voiceStates.cache.get(userId)?.channelId;
  if (cached) return cached;
  try {
    const member = await withTimeout(guild.members.fetch(userId), 5000, "member fetch");
    return member.voice.channelId ?? null;
  } catch {
    return null;
  }
}

export type ChannelLookup =
  | { ok: true; channel: VoiceBasedChannel }
  | { ok: false; error: string };

export async function resolveVoiceChannel(guild: Guild, channelId: string): Promise<ChannelLookup> {
  let channel;
  let why = "";
  try {
    channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
  } catch (err) {
    channel = null;
    // Discord's reason (Missing Access vs Unknown Channel vs a dead token) is the whole diagnosis
    const e = err as { message?: string; code?: unknown; httpStatus?: unknown };
    const parts = [e.message ?? String(err)];
    if (e.code !== undefined) parts.push(`code ${String(e.code)}`);
    if (e.httpStatus !== undefined) parts.push(`HTTP ${String(e.httpStatus)}`);
    why = ` (${parts.join(", ")})`;
  }
  if (!channel) return { ok: false, error: `channel ${channelId} not found in guild ${guild.id}${why}` };
  if (!channel.isVoice()) return { ok: false, error: `channel ${channelId} is not a voice channel` };
  const vc = channel as VoiceBasedChannel;
  if (!vc.joinable) {
    return { ok: false, error: `cannot join channel ${channelId} (missing permission, or the channel is full)` };
  }
  return { ok: true, channel: vc };
}

/** Speaker lookup for the capture path: sync when cached, one bounded fetch otherwise. */
export function makeSpeakerResolver(
  client: Client<true>,
  guild: Guild,
  log: Logger,
): (userId: string) => SpeakerInfo | null | Promise<SpeakerInfo | null> {
  const info = (member: GuildMember | null, user: User, id: string): SpeakerInfo => ({
    isBot: user.bot === true,
    displayName: displayNameFor(member, user, id),
  });
  return (userId) => {
    const member = guild.members.cache.get(userId) ?? null;
    const user = member?.user ?? client.users.cache.get(userId) ?? null;
    if (user) return info(member, user, userId);
    return withTimeout(guild.members.fetch(userId), 3000, "member fetch").then(
      (m) => info(m, m.user, userId),
      (err: unknown) => {
        log.debug(`could not resolve speaker ${userId}:`, err);
        return null;
      },
    );
  };
}
