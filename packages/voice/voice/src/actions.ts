// Capabilities of the voice node: `voice.join`, `voice.leave`, `stream.start` and `stream.stop`
// (Discord Go Live; OBS follows `voice.golive` on the Stage side), and `voice.status` (the voice
// channel's status line, set by the bot account). Registered in the actuator
// registry by the voice module; `/voice ...` and her tools both call them through the gate.
//
// With the ActivityManager (module `activity`) they are its presence and broadcast transitions
// (`ensure_voice`, `leave_voice`, `ensure_live`, `stop_live`): the gate decides, then the manager
// serializes them, answers idempotently and runs these executors as steps of its tasks. Without
// it they run directly, with the same rules: joining while already in voice there stays put, and
// leaving ends the Go Live first.
//
// Leaving on her own (principal `self`) is refused while she still has songs to sing there, and
// for `STAY_AFTER_INVITE_MS` after someone brought her into voice while people are still in it:
// her mind took the quiet of people listening to a song for a quiet channel and kept leaving
// mid-song, and her friends kept calling her back. A person or a command can still send her away.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/gate/actions";
import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type ActivityRequest,
  actLane,
  PlatformSinksKey,
  type Principal,
  StreamCurtainKey,
  type VoiceFloor,
  type WorldState,
} from "@miyoria/types";
import { z } from "zod";
import { type VoiceLink, voiceContext } from "./link/link.js";

/** Joining her voice channel failed while starting Go Live. */
export class GoLiveJoinError extends CapabilityError {
  override readonly name = "GoLiveJoinError";
}

const Id = z.string().trim().min(1).max(64);

const GuildArgs = z.object({ guild: Id.nullish() });
/**
 * A voice channel id as she may write it: the bare id, a `<#id>` mention, or the id at the end
 * of a context key she saw (`guild:channel`, `discord:guild:channel`), which Discord rejects.
 */
export function channelIdOf(raw: string): string {
  const mention = /^<#(\d+)>$/.exec(raw);
  if (mention?.[1]) return mention[1];
  const parts = raw.split(":").filter((p) => p !== "");
  return parts.at(-1) ?? raw;
}

const ChannelId = Id.transform(channelIdOf);
const JoinArgs = GuildArgs.extend({ channel: ChannelId.nullish() });
const GoLiveArgs = GuildArgs.extend({ source: z.string().trim().min(1).nullish() });
const StatusArgs = GuildArgs.extend({ status: z.string().trim().max(500) });
type GuildArgs = z.output<typeof GuildArgs>;
type StatusArgs = z.output<typeof StatusArgs>;
type JoinArgs = z.output<typeof JoinArgs>;
type GoLiveArgs = z.output<typeof GoLiveArgs>;

/** The guild of the request: the argument, else the principal's context. */
function guildOf(args: GuildArgs, principal: Principal): string | null {
  return args.guild ?? principal.context?.scope ?? null;
}

function requireGuild(args: GuildArgs, principal: Principal): string {
  const guild = guildOf(args, principal);
  if (guild === null) throw new CapabilityError("not in a server");
  return guild;
}

/**
 * The platform a call is on: where it was asked, else whose account asked; `null` when neither
 * says (a panel or director call), and the capabilities then ask the voice node's own account.
 * Never a default platform (v5-architecture §6).
 */
export function platformOf(principal: Principal): string | null {
  return principal.context?.platform ?? principal.requester?.platform ?? null;
}

/** The platform of a call, the voice node's account answering when the call does not say. */
type PlatformOf = (principal: Principal) => string | null;

function laneOf(platform: PlatformOf) {
  return (args: GuildArgs, principal: Principal): string | null => {
    const guild = guildOf(args, principal);
    const on = platform(principal);
    return guild === null || on === null ? null : actLane(`voice:${on}:${guild}`);
  };
}

/**
 * The ActivityManager request of a guild-scoped call (`null`: no guild or no platform, the
 * executor refuses).
 */
function inGuild(
  args: GuildArgs,
  principal: Principal,
  platform: PlatformOf,
  request: (guild: string, platform: string) => ActivityRequest,
): ActivityRequest[] | null {
  const guild = guildOf(args, principal);
  const on = platform(principal);
  return guild === null || on === null ? null : [request(guild, on)];
}

function requireNode(link: VoiceLink): void {
  if (!link.isConnected()) throw new CapabilityError("her voice account is not online");
}

const GUILD_PROPERTY = { type: "string", description: "伺服器 id(省略 = 這個伺服器)" };

/** After someone brings her into voice, she does not leave on her own for this long (ms). */
export const STAY_AFTER_INVITE_MS = 20 * 60_000;

/** People other than her in her voice channel of `guild`. */
function othersInVoice(
  guild: string,
  channel: string | null,
  world: WorldState | undefined,
): number {
  if (channel === null) return 0;
  const vc = world
    ?.snapshot()
    .voice_channels.find((c) => c.guild === guild && c.channel === channel);
  return vc ? vc.members.filter((m) => !m.is_self).length : 0;
}

/** A channel name as people and she write it: no `#`, no quotes around it, case and width folded. */
function channelName(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .replace(/^#/, "")
    .replace(/^[「『“"'‘]+|[」』”"'’]+$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * The voice channel `raw` means in `guild`: an id, or the name of a voice channel the bot sees
 * (she reads names in her context and writes them here). `unknown` is a name that fits no channel:
 * on Discord an id is digits, so anything else that is not a known name cannot be joined, and
 * sending it made Discord answer "not snowflake". The caller then joins as if no channel was given.
 */
export function wantedChannel(
  raw: string | null | undefined,
  guild: string,
  principal: Principal,
  world: WorldState | undefined,
  platform: string | null = platformOf(principal),
): { channel: string | null; unknown: string | null } {
  if (raw == null) return { channel: null, unknown: null };
  const voices = (world?.snapshot().voice_channels ?? []).filter((c) => c.guild === guild);
  if (voices.some((c) => c.channel === raw)) return { channel: raw, unknown: null };
  const wanted = channelName(raw);
  const named = voices.filter((c) => c.name != null && channelName(c.name) === wanted);
  if (named.length > 0) {
    // Two channels may share a name: the one the person asking is in, else the fullest.
    const asker = principal.requester ? (world?.person(principal.requester)?.voice ?? null) : null;
    const people = (c: (typeof named)[number]) => c.members.filter((m) => !m.is_self).length;
    const best =
      named.find((c) => asker !== null && asker.guild === guild && asker.channel === c.channel) ??
      [...named].sort((a, b) => people(b) - people(a))[0];
    if (best) return { channel: best.channel, unknown: null };
  }
  if (platform === "discord" && !/^\d+$/.test(raw)) {
    return { channel: null, unknown: raw };
  }
  return { channel: raw, unknown: null };
}

/**
 * Where to join for `principal`'s request in `guild`: the requester's current voice channel as the
 * bot sees it (`world`), else ask the voice node to look the requester up (`follow`).
 */
export function joinTarget(
  guild: string,
  principal: Principal,
  world: WorldState | undefined,
): { channel: string | null; follow: string | null } {
  const requester = principal.requester ?? null;
  if (requester === null) {
    // Nobody asked (her own idea): the voice channel of this server with the most people in it.
    const busiest = (world?.snapshot().voice_channels ?? [])
      .filter((c) => c.guild === guild)
      .map((c) => ({ channel: c.channel, people: c.members.filter((m) => !m.is_self).length }))
      .filter((c) => c.people > 0)
      .sort((a, b) => b.people - a.people)[0];
    return { channel: busiest?.channel ?? null, follow: null };
  }
  const spot = world?.person(requester)?.voice ?? null;
  if (spot !== null && spot.guild === guild && spot.platform === requester.platform) {
    return { channel: spot.channel, follow: null };
  }
  return { channel: null, follow: requester.id };
}

/**
 * Where Go Live reads from by default: the source, and whether the node's ffmpeg is the server
 * the encoder pushes to (`listen`, default true) or pulls from one (false, e.g. MediaMTX).
 */
export interface GoLiveDefaults {
  source: string;
  listen?: boolean;
}

/** The four capabilities, bound to `link` (and the default Go Live source, or its defaults). */
export function voiceCapabilities(
  link: VoiceLink,
  goliveSource: () => string | GoLiveDefaults,
  world: () => WorldState | undefined = () => undefined,
  floor: () => VoiceFloor | undefined = () => undefined,
  now: () => number = Date.now,
): Capability[] {
  /** When someone (not she herself) last brought her into voice, per guild. */
  const invitedAt = new Map<string, number>();
  const platform: PlatformOf = (principal) =>
    platformOf(principal) ?? link.selfAccount()?.platform ?? null;
  const lane = laneOf(platform);

  /** Why she may not leave `guild` on her own now, or `null`. */
  function stay(guild: string): string | null {
    const songs = floor();
    if (songs?.holder(guild)) return "正在唱歌:唱完、歌單也唱完再離開語音";
    const pending = songs?.pending?.(guild) ?? 0;
    if (pending > 0) return `還有 ${pending} 首歌在準備或等著唱:唱完再離開語音`;
    const invited = invitedAt.get(guild);
    if (invited !== undefined && now() - invited < STAY_AFTER_INVITE_MS) {
      const people = othersInVoice(guild, link.channel(guild), world());
      if (people > 0) {
        const minutes = Math.max(1, Math.round((now() - invited) / 60_000));
        return `${minutes} 分鐘前有人叫你進語音,大家(${people} 人)還在:先待著,想安靜可以少說話`;
      }
    }
    return null;
  }

  const join = defineCapability<JoinArgs>({
    name: "voice.join",
    summary: "加入語音頻道",
    risk: "medium",
    args: JoinArgs,
    permission: "voice.join",
    tool: {
      name: "voice_join",
      meta: { effect: "act", speed: "long", group: "voice" },
      description:
        "進語音頻道。有 channel 就直接進那個頻道,裡面沒人也可以。channel 省略 = 跟你說話的人現在所在的語音頻道(對方要在語音裡)。",
      properties: {
        channel: { type: "string", description: "語音頻道的名字或 id(通常省略)" },
        guild: GUILD_PROPERTY,
      },
    },
    scope: guildOf,
    lane,
    activity: (args, principal) =>
      inGuild(args, principal, platform, (guild, on) => ({
        type: "ensure_voice",
        platform: on,
        guild,
        // A name that fits no channel counts as no channel: the manager then leaves her where
        // she is, or joins the person asking.
        channel: wantedChannel(args.channel, guild, principal, world(), on).channel,
        follow: principal.requester,
      })),
    async execute(args, ctx) {
      const guild = requireGuild(args, ctx.principal);
      requireNode(link);
      const wanted = wantedChannel(
        args.channel,
        guild,
        ctx.principal,
        world(),
        platform(ctx.principal),
      );
      const current = link.channel(guild);
      if (current !== null && (wanted.channel === null || wanted.channel === current)) {
        // Idempotent: already in voice here; asking again never moves her to another channel.
        return {
          text: `already in voice channel ${current}`,
          data: { channel: current, already: true },
        };
      }
      const target =
        wanted.channel !== null
          ? { channel: wanted.channel, follow: null }
          : joinTarget(guild, ctx.principal, world());
      if (target.channel === null && target.follow === null) {
        throw new CapabilityError(
          wanted.unknown !== null
            ? `no voice channel named "${wanted.unknown}" here and nobody to follow`
            : "no channel given and nobody to follow",
        );
      }
      const joined = await link.join(guild, target.channel, target.follow);
      if (ctx.principal.kind !== "self") invitedAt.set(guild, now());
      const note =
        wanted.unknown !== null
          ? ` (no voice channel named "${wanted.unknown}" here: joined the person asking instead)`
          : "";
      return {
        text: `joined voice channel ${joined}${note}`,
        data: { channel: joined, already: false },
      };
    },
  });

  /**
   * Go Live pulls from a hub (MediaMTX) that OBS publishes to for the website as well: ending Go
   * Live then leaves OBS alone, so the website never sees the ending scene.
   */
  const fromHub = (): boolean => {
    const defaults = goliveSource();
    return typeof defaults !== "string" && defaults.listen === false;
  };

  const leave = defineCapability<GuildArgs>({
    name: "voice.leave",
    summary: "離開語音頻道",
    risk: "medium",
    args: GuildArgs,
    permission: "voice.leave",
    tool: {
      name: "voice_leave",
      meta: { effect: "act", speed: "instant", group: "voice" },
      description: "離開你現在所在的語音頻道。",
      properties: { guild: GUILD_PROPERTY },
    },
    scope: guildOf,
    lane,
    activity: (args, principal) =>
      inGuild(args, principal, platform, () => ({ type: "leave_voice" })),
    check(args, principal) {
      if (principal.kind !== "self") return null;
      const guild = guildOf(args, principal);
      return guild === null ? null : stay(guild);
    },
    async execute(args, ctx) {
      const guild = requireGuild(args, ctx.principal);
      if (link.channel(guild) === null) {
        return { text: "she is not in a voice channel", data: { left: false } };
      }
      // Without the ActivityManager (it stops the broadcast as its own step): Go Live ends
      // first, with the curtain, so she never streams from a call she left.
      if (!ctx.task && link.isStreaming(guild)) {
        if (!fromHub()) await ctx.services.get(StreamCurtainKey)?.close(ctx.signal);
        await link.goliveStop(guild);
      }
      await link.leave(guild);
      return { text: "left the voice channel", data: { left: true } };
    },
  });

  const start = defineCapability<GoLiveArgs>({
    name: "stream.start",
    summary: "開始 Go Live 直播",
    risk: "medium",
    args: GoLiveArgs,
    permission: "voice.golive",
    tool: {
      name: "stream_start",
      meta: { effect: "act", speed: "long", group: "stream" },
      description:
        "開直播 / 開台:在 Discord 語音頻道 Go Live(直播機的 OBS 會跟著開播),跟玩遊戲無關。還不在語音時會先進對方所在的語音頻道。",
      properties: { guild: GUILD_PROPERTY },
    },
    scope: guildOf,
    lane,
    activity: (args, principal) =>
      inGuild(args, principal, platform, (guild, on) => ({
        type: "ensure_live",
        platform: on,
        guild,
        source: args.source ?? null,
      })),
    async execute(args, ctx) {
      const guild = requireGuild(args, ctx.principal);
      requireNode(link);
      if (link.isStreaming(guild)) {
        return { text: "already live", data: { already: true, joined: false } };
      }
      const defaults = goliveSource();
      const { source: fallback, listen } =
        typeof defaults === "string" ? { source: defaults, listen: undefined } : defaults;
      const source = (args.source ?? fallback).trim();
      if (source === "") throw new CapabilityError("no Go Live source configured");
      let joined = false;
      if (link.channel(guild) === null) {
        const target = joinTarget(guild, ctx.principal, world());
        if (target.channel === null && target.follow === null) {
          throw new GoLiveJoinError("not in voice and nobody to follow");
        }
        try {
          await link.join(guild, target.channel, target.follow);
          joined = true;
        } catch (error) {
          throw new GoLiveJoinError(errorMessage(error), { cause: error });
        }
      }
      // Only a pull is said out loud: the node's default (listen) stays its own.
      await link.goliveStart({ guild, source, ...(listen === false ? { listen } : {}) });
      return { text: "Go Live started", data: { already: false, joined } };
    },
  });

  const stop = defineCapability<GuildArgs>({
    name: "stream.stop",
    summary: "結束 Go Live 直播",
    risk: "medium",
    args: GuildArgs,
    permission: "voice.golive",
    tool: {
      name: "stream_stop",
      meta: { effect: "act", speed: "instant", group: "stream" },
      description: "結束 Discord Go Live 直播。",
      properties: { guild: GUILD_PROPERTY },
    },
    scope: guildOf,
    lane,
    activity: (args, principal) =>
      inGuild(args, principal, platform, () => ({ type: "stop_live" })),
    async execute(args, ctx) {
      const guild = requireGuild(args, ctx.principal);
      if (!link.isStreaming(guild)) return { text: "not live", data: { stopped: false } };
      // The stage shows the ending scene for a moment first (when it has one), unless OBS goes on
      // for the website.
      if (!fromHub()) await ctx.services.get(StreamCurtainKey)?.close(ctx.signal);
      await link.goliveStop(guild);
      return { text: "Go Live stopped", data: { stopped: true } };
    },
  });

  // The status line goes through the bot account's sink (its REST client), not the voice node.
  const status = defineCapability<StatusArgs>({
    name: "voice.status",
    summary: "改語音頻道狀態",
    risk: "low",
    args: StatusArgs,
    permission: "voice.status",
    tool: {
      name: "voice_status",
      meta: { effect: "act", speed: "instant", group: "voice" },
      description:
        "改你現在所在語音頻道的「頻道狀態」(頻道名稱下面那一行字,大家都看得到),例如「🎤 唱歌中」「聊天中」。status 空字串 = 清掉。",
      properties: {
        status: { type: "string", description: "狀態文字(最多 500 字,空字串清掉)" },
        guild: GUILD_PROPERTY,
      },
      required: ["status"],
    },
    scope: guildOf,
    lane,
    async execute(args, ctx) {
      const guild = requireGuild(args, ctx.principal);
      const channel = link.channel(guild);
      if (channel === null) throw new CapabilityError("she is not in a voice channel there");
      const on = platform(ctx.principal);
      if (on === null) throw new CapabilityError("which platform is not known");
      const sink = ctx.services.get(PlatformSinksKey)?.get(on);
      if (!sink?.setVoiceStatus) throw new CapabilityError("this platform has no voice status");
      await sink.setVoiceStatus(voiceContext(on, guild, channel), args.status, ctx.signal);
      return {
        text: args.status === "" ? "voice status cleared" : "voice status set",
        data: { channel, status: args.status },
      };
    },
  });

  return [join, leave, start, stop, status] as Capability[];
}
