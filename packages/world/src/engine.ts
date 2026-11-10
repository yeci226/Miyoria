// The world model: pure state plus the cheap salience rules. Inputs are passed in with `now`
// (epoch ms), so tests drive it without timers; the module feeds it from the bus.
//
// Rules (no LLM):
//
// * `came_online`: someone she cares about went from offline to online / idle / dnd.
// * `joined_voice`: someone she cares about joined (or moved to) a voice channel.
// * `started_game`: someone started playing a game she is interested in.
// * `channel_quiet`: a lively channel had no messages for `quiet_after_secs`, or the voice
//   channel she is in went quiet after a conversation (nobody, her included, said anything for
//   `voice_quiet_secs`). The one "cold channel" signal (docs/design/v2-architecture.md §3.3):
//   her mind / Plan wakes on it and decides whether to raise something.
// * `mentioned`: she was mentioned / replied to in a guild context she has not spoken in for
//   `away_secs`.
//
// Snapshot updates (`initial`) never trigger rules. "Cares about" = not blocked and affinity or
// familiarity at least the configured minimum.

import {
  type AccountRef,
  type ActivitySnapshot,
  type Attitude,
  type Author,
  accountRefString,
  type ChannelActivity,
  type ContextKey,
  contextKeyString,
  type HerStatus,
  type IncomingMessage,
  type MemberUpdate,
  type PersonPresence,
  type PlatformId,
  type PresenceActivity,
  type PresenceStatus,
  type PresenceUpdate,
  type TimeContext,
  toTimestamp,
  type VoiceActivity,
  type VoiceChannelState,
  type VoiceMember,
  type VoiceStateUpdate,
  type WorldSnapshot,
  type WorldSummaryOptions,
} from "@miyoria/types";
import type { WorldConfig } from "./config.js";
import type { Candidate } from "./salience.js";
import { durationText, timeContext, weekdayName } from "./time.js";
import { topicWords } from "./topic.js";

/** What the engine asks other modules at the moment it needs it. */
export interface Signals {
  attitude(account: AccountRef): Attitude | null;
}

export const NO_SIGNALS: Signals = { attitude: () => null };

/** Lines of a channel kept for activity and topics. */
const MAX_LINES = 60;
/** Characters kept of each line (only used for topic words). */
const MAX_LINE_CHARS = 200;
/** Lines the topic words are taken from. */
const TOPIC_LINES = 30;
/** Text contexts listed in the prompt summary besides the current one. */
const SUMMARY_OTHER_CHANNELS = 2;

interface MemberRec {
  account: AccountRef;
  display_name: string;
  is_bot: boolean;
  guilds: Set<string>;
}

interface PresenceRec {
  account: AccountRef;
  display_name: string;
  status: PresenceStatus;
  activities: PresenceActivity[];
  online_since: number | null;
  updated_at: number;
}

interface VoiceRec {
  platform: PlatformId;
  guild: string;
  account: AccountRef;
  display_name: string;
  channel: string;
  channel_name: string | null;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  streaming: boolean;
  since: number;
}

interface Line {
  at: number;
  author: string;
  text: string;
}

/** Utterances and her own lines in one voice channel (`platform:guild:channel`). */
interface VoiceLines {
  lines: { at: number; speaker: string }[];
  her_last_at: number | null;
  touched: number;
  /** The current lull was reported (a new utterance clears it). */
  lulled: boolean;
}

/** Lines of the others within this long before the last make a voice conversation. */
const VOICE_CONVERSATION_MS = 5 * 60_000;
const VOICE_CONVERSATION_LINES = 3;

interface ChannelRec {
  context: ContextKey;
  lines: Line[];
  lively: boolean;
  her_last_at: number | null;
  touched: number;
}

const accKey = accountRefString;
const ctxKey = (c: ContextKey) => `${contextKeyString(c)}#${c.kind}`;

/** One line of untrusted text for prompts: no line breaks, limited length. */
export function oneLine(text: string, max = 40): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const flat = text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

function interestMatcher(interests: readonly string[]): (name: string) => boolean {
  const tests: ((name: string) => boolean)[] = [];
  for (const raw of interests) {
    const interest = raw.trim().toLowerCase();
    if (interest.length < 2) continue;
    if (/^[\x20-\x7e]+$/.test(interest)) {
      // Latin interests match whole words ("AI" must not match "Rainbow").
      const escaped = interest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`);
      tests.push((name) => re.test(name));
    } else {
      tests.push((name) => name.includes(interest));
    }
  }
  return (name) => {
    const lower = name.toLowerCase();
    return tests.some((t) => t(lower));
  };
}

export class WorldEngine {
  readonly #members = new Map<string, MemberRec>();
  readonly #presence = new Map<string, PresenceRec>();
  /** By `account|guild`. */
  readonly #voice = new Map<string, VoiceRec>();
  readonly #channels = new Map<string, ChannelRec>();
  /** Voice conversation by `platform:guild:channel`. */
  readonly #voiceTalk = new Map<string, VoiceLines>();
  readonly #selfIds = new Set<string>();
  readonly #interesting: (name: string) => boolean;
  readonly #golive = new Map<string, string>();
  #herVoice: ContextKey | null = null;
  #stage = { streaming: false, scene: null as string | null };

  constructor(
    private readonly config: WorldConfig,
    interests: readonly string[],
    /** Presence privacy: `false` = drop their presence entirely. */
    private readonly allowed: (account: AccountRef) => boolean = () => true,
  ) {
    this.#interesting = interestMatcher([...interests, ...config.game_interests]);
  }

  // ---- inputs ---------------------------------------------------------------------------

  addSelf(account: AccountRef): void {
    this.#selfIds.add(accKey(account));
    this.#presence.delete(accKey(account));
  }

  isSelf(account: AccountRef): boolean {
    return this.#selfIds.has(accKey(account));
  }

  /** Drops everything presence-related about `account` (they opted out). */
  forgetPresence(account: AccountRef): void {
    this.#presence.delete(accKey(account));
  }

  /** Whether data from `guild` is followed (`guilds` config). */
  follows(guild: string | null): boolean {
    if (guild === null) return false;
    return this.config.guilds.length === 0 || this.config.guilds.includes(guild);
  }

  presence(u: PresenceUpdate, now: number, sig: Signals): Candidate[] {
    const key = accKey(u.account);
    if (!this.follows(u.guild) || u.is_bot || this.#selfIds.has(key)) return [];
    if (!this.allowed(u.account)) {
      this.#presence.delete(key);
      return [];
    }
    this.#noteMember(u.account, u.guild, u.display_name, u.is_bot);
    const prev = this.#presence.get(key);
    const prevStatus: PresenceStatus | null =
      prev?.status ?? (this.#members.has(key) ? "offline" : null);
    const online = u.status !== "offline";
    const wasOnline = prev !== undefined && prev.status !== "offline";
    this.#presence.set(key, {
      account: u.account,
      display_name: u.display_name,
      status: u.status,
      activities: u.activities,
      online_since: online ? (wasOnline ? (prev?.online_since ?? now) : now) : null,
      updated_at: now,
    });
    if (u.initial) return [];

    const out: Candidate[] = [];
    const att = sig.attitude(u.account);
    const name = oneLine(u.display_name, 32);
    if (online && prevStatus === "offline" && this.#cares(att)) {
      out.push({
        kind: "came_online",
        key: `came_online:${key}`,
        account: u.account,
        person: att?.person ?? null,
        display_name: u.display_name,
        context: null,
        detail: `${name} 上線了`,
        score: 0.4 + 0.3 * affinityWeight(att),
      });
    }
    const before = new Set(
      (prev?.activities ?? []).filter((a) => a.type === "playing").map((a) => a.name.toLowerCase()),
    );
    for (const a of u.activities) {
      if (a.type !== "playing" || a.name === "" || before.has(a.name.toLowerCase())) continue;
      if (!this.#interesting(a.name)) continue;
      out.push({
        kind: "started_game",
        key: `started_game:${key}:${a.name.toLowerCase()}`,
        account: u.account,
        person: att?.person ?? null,
        display_name: u.display_name,
        context: null,
        detail: `${name} 開始玩 ${oneLine(a.name, 40)}`,
        score: this.#cares(att) ? 0.6 : 0.5,
      });
    }
    return out;
  }

  voiceState(u: VoiceStateUpdate, now: number, sig: Signals): Candidate[] {
    if (!this.follows(u.guild)) return [];
    const key = `${accKey(u.account)}|${u.guild}`;
    const prev = this.#voice.get(key);
    const self = this.#selfIds.has(accKey(u.account));
    this.#noteMember(u.account, u.guild, u.display_name, u.is_bot);
    if (u.channel === null) {
      this.#voice.delete(key);
      if (self && this.#herVoice?.scope === u.guild) this.#herVoice = null;
      return [];
    }
    this.#voice.set(key, {
      platform: u.platform,
      guild: u.guild,
      account: u.account,
      display_name: u.display_name,
      channel: u.channel,
      channel_name: u.channel_name,
      muted: u.self_mute || u.server_mute,
      deafened: u.self_deaf || u.server_deaf,
      video: u.video,
      streaming: u.streaming,
      since: prev?.channel === u.channel ? prev.since : now,
    });
    if (self) {
      this.#herVoice = { platform: u.platform, scope: u.guild, channel: u.channel, kind: "voice" };
      return [];
    }
    if (u.initial || u.is_bot || prev?.channel === u.channel) return [];
    const att = sig.attitude(u.account);
    if (!this.#cares(att)) return [];
    const channel = oneLine(u.channel_name ?? u.channel, 32);
    return [
      {
        kind: "joined_voice",
        key: `joined_voice:${accKey(u.account)}:${u.channel}`,
        account: u.account,
        person: att?.person ?? null,
        display_name: u.display_name,
        context: { platform: u.platform, scope: u.guild, channel: u.channel, kind: "voice" },
        detail: `${oneLine(u.display_name, 32)} 進了語音頻道「${channel}」`,
        score: 0.5 + 0.3 * affinityWeight(att),
      },
    ];
  }

  member(u: MemberUpdate): void {
    if (!this.follows(u.guild)) return;
    const key = accKey(u.account);
    if (!u.left) {
      this.#noteMember(u.account, u.guild, u.display_name, u.is_bot);
      return;
    }
    const rec = this.#members.get(key);
    rec?.guilds.delete(u.guild);
    this.#voice.delete(`${key}|${u.guild}`);
    if (!rec || rec.guilds.size === 0) {
      this.#members.delete(key);
      this.#presence.delete(key);
    }
  }

  message(m: IncomingMessage, now: number, sig: Signals): Candidate[] {
    const context = m.id.context;
    // DMs never show up in the world (they would leak into public prompts).
    if (context.kind === "dm" || !this.follows(context.scope)) return [];
    if (this.#selfIds.has(accKey(m.author.account))) {
      this.herSpoke(context, now);
      return [];
    }
    if (m.author.is_bot) return [];
    const rec = this.#channel(context, now);
    rec.lines.push({
      at: now,
      author: m.author.display_name,
      text: [...m.text].slice(0, MAX_LINE_CHARS).join(""),
    });
    if (rec.lines.length > MAX_LINES) rec.lines.splice(0, rec.lines.length - MAX_LINES);
    this.#prune(rec, now);
    if (!rec.lively) rec.lively = this.#isLively(rec);

    if (!(m.mentions_self || m.reply_to_self)) return [];
    const away = rec.her_last_at === null || now - rec.her_last_at >= this.config.away_secs * 1000;
    if (!away) return [];
    const att = sig.attitude(m.author.account);
    return [
      {
        kind: "mentioned",
        key: `mentioned:${ctxKey(context)}`,
        account: m.author.account,
        person: att?.person ?? null,
        display_name: m.author.display_name,
        context,
        detail: `${oneLine(m.author.display_name, 32)} 在你最近沒參與的頻道提到你`,
        score: 0.8,
      },
    ];
  }

  /** She said something in `context` (her own message or a finished turn). */
  herSpoke(context: ContextKey, now: number): void {
    if (context.kind === "dm" || !this.follows(context.scope)) return;
    if (context.kind === "voice") {
      this.#voiceLines(context, now).her_last_at = now;
      return;
    }
    this.#channel(context, now).her_last_at = now;
  }

  /**
   * Someone said something in a voice channel (a transcribed utterance). Her own and bots'
   * lines are not conversation; hers only update `her_last_at`.
   */
  utterance(context: ContextKey, speaker: Author, now: number): void {
    if (context.kind !== "voice" || !this.follows(context.scope)) return;
    if (this.#selfIds.has(accKey(speaker.account))) {
      this.herSpoke(context, now);
      return;
    }
    if (speaker.is_bot) return;
    const rec = this.#voiceLines(context, now);
    rec.lulled = false;
    rec.lines.push({ at: now, speaker: speaker.display_name });
    if (rec.lines.length > MAX_LINES) rec.lines.splice(0, rec.lines.length - MAX_LINES);
    this.#pruneVoice(rec, now);
  }

  /** Recent conversation in the voice channel `context`, if anything is known about it. */
  voiceActivity(context: ContextKey, now: number): VoiceActivity | null {
    const key = voiceKey(context.platform, context.scope ?? "", context.channel);
    const rec = this.#voiceTalk.get(key);
    const hers =
      this.#herVoice !== null &&
      this.#herVoice.scope === context.scope &&
      this.#herVoice.channel === context.channel;
    // Only where she listens is silence a fact; elsewhere nothing is known.
    if (!rec && !hers) return null;
    const windowMs = this.config.voice_activity_window_secs * 1000;
    const lines = (rec?.lines ?? []).filter((l) => now - l.at < windowMs);
    const speakers: string[] = [];
    for (const l of [...lines].reverse()) {
      if (!speakers.includes(l.speaker)) speakers.push(l.speaker);
    }
    const last = lines.at(-1)?.at ?? null;
    const sinceLast = last === null ? null : Math.max(0, Math.round((now - last) / 1000));
    const minutes = Math.max(windowMs / 60_000, 1);
    const herLast = rec?.her_last_at ?? null;
    return {
      recent_utterances: lines.length,
      per_minute: Math.round((lines.length / minutes) * 100) / 100,
      last_at: last === null ? null : toTimestamp(last),
      secs_since_last: sinceLast,
      recent_speakers: speakers.slice(0, 8),
      lively:
        lines.length >= Math.max(this.config.voice_lively_lines, 1) ||
        (sinceLast !== null && sinceLast < this.config.voice_quiet_secs),
      her_last_at: herLast === null ? null : toTimestamp(herLast),
    };
  }

  voiceJoined(context: ContextKey): void {
    this.#herVoice = { ...context, kind: "voice" };
  }

  voiceLeft(context: ContextKey): void {
    if (this.#herVoice && this.#herVoice.scope === context.scope) this.#herVoice = null;
  }

  stageStatus(status: { connected: boolean; streaming: boolean; scene: string | null }): void {
    this.#stage = status.connected
      ? { streaming: status.streaming, scene: status.scene }
      : { streaming: false, scene: null };
  }

  golive(guild: string, state: string): void {
    if (state === "stopped" || state === "failed") this.#golive.delete(guild);
    else this.#golive.set(guild, state);
  }

  /** Quiet channels; prunes old lines. */
  tick(now: number): Candidate[] {
    const out: Candidate[] = [];
    const quietMs = this.config.quiet_after_secs * 1000;
    const forgetMs = Math.max(this.config.activity_window_secs * 1000, quietMs) * 6;
    for (const [key, rec] of this.#channels) {
      const last = rec.lines.at(-1)?.at ?? null;
      if (rec.lively && last !== null && now - last >= quietMs) {
        rec.lively = false;
        out.push({
          kind: "channel_quiet",
          key: `channel_quiet:${key}`,
          account: null,
          person: null,
          display_name: null,
          context: rec.context,
          detail: "剛剛很熱鬧的頻道安靜下來了",
          score: 0.3,
        });
      }
      this.#prune(rec, now);
      if (rec.lines.length === 0 && now - rec.touched >= forgetMs) this.#channels.delete(key);
    }
    const voiceForgetMs = this.config.voice_activity_window_secs * 1000 * 6;
    for (const [key, rec] of this.#voiceTalk) {
      const lull = this.#voiceLull(key, rec, now);
      if (lull) out.push(lull);
      this.#pruneVoice(rec, now);
      if (rec.lines.length === 0 && now - rec.touched >= voiceForgetMs) {
        this.#voiceTalk.delete(key);
      }
    }
    return out;
  }

  /** The voice channel she is in (`key`) went quiet after a conversation (once per lull). */
  #voiceLull(key: string, rec: VoiceLines, now: number): Candidate | null {
    const here = this.#herVoice;
    if (here === null || rec.lulled) return null;
    if (voiceKey(here.platform, here.scope ?? "", here.channel) !== key) return null;
    const last = rec.lines.at(-1)?.at ?? null;
    const quietMs = this.config.voice_quiet_secs * 1000;
    if (last === null || now - last < quietMs) return null;
    if (rec.her_last_at !== null && now - rec.her_last_at < quietMs) return null;
    const lines = rec.lines.filter((l) => last - l.at < VOICE_CONVERSATION_MS).length;
    if (lines < VOICE_CONVERSATION_LINES) return null;
    rec.lulled = true;
    return {
      kind: "channel_quiet",
      key: `channel_quiet:${key}#voice`,
      account: null,
      person: null,
      display_name: null,
      context: { ...here, kind: "voice" },
      detail: `語音裡大家 ${Math.round((now - last) / 1000)} 秒沒說話了(之前 5 分鐘 ${lines} 句)`,
      score: 0.3,
    };
  }

  // ---- queries --------------------------------------------------------------------------

  snapshot(
    now: number,
    sig: Signals,
    game: string | null,
    activity: ActivitySnapshot | null = null,
  ): WorldSnapshot {
    return {
      at: toTimestamp(now),
      time: this.time(now),
      her: this.her(game, activity),
      people: this.people(sig),
      voice_channels: this.voiceChannels(sig, now),
      channels: this.channels(now),
    };
  }

  time(now: number): TimeContext {
    return timeContext(now, this.config.utc_offset_minutes);
  }

  /**
   * Her own situation. With the ActivityManager's snapshot (`activity`) her voice channel, the
   * broadcast, the game and the song come from it (the one copy everyone reads); without it, from
   * what the world saw on the bus. The OBS scene is always the one OBS reports.
   */
  her(game: string | null, activity: ActivitySnapshot | null = null): HerStatus {
    if (activity !== null) return this.#herFrom(game, activity);
    const voice = this.#herVoice;
    let voiceName: string | null = null;
    if (voice) {
      for (const v of this.#voice.values()) {
        if (v.guild === voice.scope && v.channel === voice.channel && v.channel_name !== null) {
          voiceName = v.channel_name;
          break;
        }
      }
    }
    const golive = voice?.scope ? (this.#golive.get(voice.scope) ?? null) : null;
    return {
      voice: voice ? { ...voice } : null,
      voice_name: voiceName,
      golive: golive ?? [...this.#golive.values()][0] ?? null,
      streaming: this.#stage.streaming,
      scene: this.#stage.scene,
      game,
      singing: null,
    };
  }

  #herFrom(game: string | null, snapshot: ActivitySnapshot): HerStatus {
    const p = snapshot.presence;
    const voice = p.type === "in" ? { ...p.channel } : null;
    let voiceName: string | null = null;
    if (voice) {
      for (const v of this.#voice.values()) {
        if (v.guild === voice.scope && v.channel === voice.channel && v.channel_name !== null) {
          voiceName = v.channel_name;
          break;
        }
      }
    }
    const b = snapshot.broadcast;
    const golive = b.type === "off" ? null : b.golive ? "live" : b.type === "live" ? null : b.type;
    const a = snapshot.activity;
    const running = a.type !== "idle" && a.phase === "running";
    return {
      voice,
      voice_name: voiceName,
      golive,
      streaming: b.type !== "off" && b.obs,
      scene: this.#stage.scene,
      game: running && a.type === "game" ? (game ?? a.target) : null,
      singing: running && a.type === "singing" ? a.target : null,
    };
  }

  person(account: AccountRef, sig: Signals): PersonPresence | null {
    const key = accKey(account);
    if (this.#selfIds.has(key)) return null;
    const presence = this.#presence.get(key);
    const voice = this.#voiceOf(key);
    const member = this.#members.get(key);
    if (!presence && !voice && !member) return null;
    const name =
      presence?.display_name ?? voice?.display_name ?? member?.display_name ?? account.id;
    return {
      account,
      person: sig.attitude(account)?.person ?? null,
      display_name: name,
      status: presence?.status ?? null,
      activities: presence ? presence.activities.map((a) => ({ ...a })) : [],
      voice: voice
        ? {
            platform: voice.platform,
            guild: voice.guild,
            channel: voice.channel,
            channel_name: voice.channel_name,
          }
        : null,
      online_since:
        presence?.online_since !== null && presence?.online_since !== undefined
          ? toTimestamp(presence.online_since)
          : null,
      updated_at: toTimestamp(Math.max(presence?.updated_at ?? 0, voice?.since ?? 0)),
    };
  }

  /** Accounts known to the world (members, presences, voice). */
  accounts(): AccountRef[] {
    const out = new Map<string, AccountRef>();
    for (const m of this.#members.values()) out.set(accKey(m.account), m.account);
    for (const p of this.#presence.values()) out.set(accKey(p.account), p.account);
    for (const v of this.#voice.values()) out.set(accKey(v.account), v.account);
    return [...out.values()];
  }

  /** People online or in voice, in voice first, then by affinity, then by name. */
  people(sig: Signals): PersonPresence[] {
    const keys = new Set<string>();
    const accounts = new Map<string, AccountRef>();
    for (const p of this.#presence.values()) {
      if (p.status !== "offline") {
        keys.add(accKey(p.account));
        accounts.set(accKey(p.account), p.account);
      }
    }
    for (const v of this.#voice.values()) {
      keys.add(accKey(v.account));
      accounts.set(accKey(v.account), v.account);
    }
    const out: { p: PersonPresence; affinity: number }[] = [];
    for (const key of keys) {
      if (this.#selfIds.has(key) || this.#members.get(key)?.is_bot) continue;
      const account = accounts.get(key);
      if (!account) continue;
      const p = this.person(account, sig);
      if (p) out.push({ p, affinity: sig.attitude(account)?.affinity ?? 0 });
    }
    out.sort(
      (a, b) =>
        Number(b.p.voice !== null) - Number(a.p.voice !== null) ||
        b.affinity - a.affinity ||
        (a.p.display_name < b.p.display_name ? -1 : 1),
    );
    return out.map((x) => x.p);
  }

  voiceChannels(sig: Signals, now = 0): VoiceChannelState[] {
    const byChannel = new Map<string, VoiceChannelState>();
    const recs = [...this.#voice.values()].sort((a, b) => a.since - b.since);
    for (const v of recs) {
      const key = `${v.platform}:${v.guild}:${v.channel}`;
      let channel = byChannel.get(key);
      if (!channel) {
        channel = {
          platform: v.platform,
          guild: v.guild,
          channel: v.channel,
          name: v.channel_name,
          members: [],
          activity: this.voiceActivity(
            { platform: v.platform, scope: v.guild, channel: v.channel, kind: "voice" },
            now,
          ),
        };
        byChannel.set(key, channel);
      }
      channel.name ??= v.channel_name;
      const member: VoiceMember = {
        account: v.account,
        person: sig.attitude(v.account)?.person ?? null,
        display_name: v.display_name,
        is_self: this.#selfIds.has(accKey(v.account)),
        muted: v.muted,
        deafened: v.deafened,
        video: v.video,
        streaming: v.streaming,
        since: toTimestamp(v.since),
      };
      channel.members.push(member);
    }
    return [...byChannel.values()].sort(
      (a, b) => b.members.length - a.members.length || (a.channel < b.channel ? -1 : 1),
    );
  }

  channels(now: number): ChannelActivity[] {
    const out: ChannelActivity[] = [];
    for (const rec of this.#channels.values()) {
      const a = this.#activity(rec, now);
      if (a.recent_messages > 0 || a.her_last_at !== null) out.push(a);
    }
    return out.sort(
      (a, b) =>
        b.recent_messages - a.recent_messages ||
        (Date.parse(b.last_at ?? "") || 0) - (Date.parse(a.last_at ?? "") || 0),
    );
  }

  channel(context: ContextKey, now: number): ChannelActivity | null {
    const rec = this.#channels.get(ctxKey(context));
    return rec ? this.#activity(rec, now) : null;
  }

  /** Whether `account` is known in `guild` (member, or in one of its voice channels). */
  inGuild(account: AccountRef, guild: string): boolean {
    const key = accKey(account);
    return this.#members.get(key)?.guilds.has(guild) === true || this.#voice.has(`${key}|${guild}`);
  }

  /**
   * Compact text for prompts; empty when there is nothing worth saying. With a guild context
   * only that guild's people, voice channels and channels are mentioned.
   */
  summary(snapshot: WorldSnapshot, options: WorldSummaryOptions = {}): string {
    const ctx = options.context ?? null;
    const guild = ctx?.scope ?? null;
    const view = guild !== null ? this.#forGuild(snapshot, guild) : snapshot;
    const lines: string[] = [];
    const t = view.time;
    lines.push(`今天是${weekdayName(t.weekday)}${t.weekend ? "(週末)" : ""},${t.part_of_day}。`);

    const her = view.her;
    const doing: string[] = [];
    if (her.voice) doing.push(`在語音頻道「${oneLine(her.voice_name ?? her.voice.channel, 24)}」`);
    if (her.game) doing.push(`正在玩 ${oneLine(her.game, 32)}`);
    if (her.streaming || her.golive === "live") {
      doing.push(her.scene ? `直播中(場景:${oneLine(her.scene, 24)})` : "直播中");
    }
    if (doing.length > 0) lines.push(`你:${doing.join(",")}。`);

    const voices = view.voice_channels.filter((c) => c.members.some((m) => !m.is_self));
    if (voices.length > 0) {
      lines.push("語音頻道:");
      for (const c of voices.slice(0, 3)) {
        const names = c.members
          .map((m) => {
            if (m.is_self) return "你";
            const flags = [m.streaming ? "分享螢幕" : "", m.video ? "開視訊" : ""].filter(Boolean);
            return `${oneLine(m.display_name, 24)}${flags.length ? `(${flags.join("、")})` : ""}`;
          })
          .join("、");
        const windowMins = Math.max(Math.round(this.config.voice_activity_window_secs / 60), 1);
        const talk = c.activity ? `;${describeVoice(c.activity, windowMins)}` : "";
        lines.push(`- 「${oneLine(c.name ?? c.channel, 24)}」:${names}${talk}`);
      }
    }

    const max = options.maxPeople ?? this.config.prompt_max_people;
    const now = Date.parse(view.at);
    const online = view.people.filter((p) => p.status !== null && p.status !== "offline");
    if (online.length > 0 && max > 0) {
      lines.push("在線的人(訊息誰都能傳,不在線的人之後也會看到):");
      for (const p of online.slice(0, max)) lines.push(`- ${describePerson(p, now)}`);
      if (online.length > max) lines.push(`- 還有 ${online.length - max} 人`);
    }

    if (ctx && ctx.kind !== "voice" && ctx.kind !== "dm") {
      const here = view.channels.find(
        (c) => c.context.channel === ctx.channel && c.context.scope === ctx.scope,
      );
      if (here && here.recent_messages > 0) lines.push(`這個頻道:${describeChannel(here)}`);
    }
    const others = view.channels
      .filter((c) => c.lively && !(ctx && c.context.channel === ctx.channel))
      .slice(0, SUMMARY_OTHER_CHANNELS);
    for (const c of others) {
      lines.push(`其他熱鬧的頻道(<#${c.context.channel}>):${describeChannel(c)}`);
    }
    // Only the time line: nothing else to say.
    return lines.length <= 1 ? "" : lines.join("\n");
  }

  // ---- internals ------------------------------------------------------------------------

  #forGuild(snapshot: WorldSnapshot, guild: string): WorldSnapshot {
    const her =
      snapshot.her.voice && snapshot.her.voice.scope !== guild
        ? { ...snapshot.her, voice: null, voice_name: null }
        : snapshot.her;
    return {
      ...snapshot,
      her,
      people: snapshot.people
        .filter((p) => this.inGuild(p.account, guild))
        .map((p) => (p.voice && p.voice.guild !== guild ? { ...p, voice: null } : p)),
      voice_channels: snapshot.voice_channels.filter((c) => c.guild === guild),
      channels: snapshot.channels.filter((c) => c.context.scope === guild),
    };
  }

  #cares(att: Attitude | null): boolean {
    if (!att || att.blocked) return false;
    return (
      att.affinity >= this.config.care_min_affinity ||
      att.familiarity >= this.config.care_min_familiarity
    );
  }

  #noteMember(account: AccountRef, guild: string, name: string, isBot: boolean): void {
    const key = accKey(account);
    const rec = this.#members.get(key);
    if (rec) {
      rec.display_name = name;
      rec.is_bot = isBot;
      rec.guilds.add(guild);
    } else {
      this.#members.set(key, {
        account,
        display_name: name,
        is_bot: isBot,
        guilds: new Set([guild]),
      });
    }
  }

  #voiceOf(accountKey: string): VoiceRec | null {
    let best: VoiceRec | null = null;
    for (const v of this.#voice.values()) {
      if (accKey(v.account) !== accountKey) continue;
      if (!best || v.since > best.since) best = v;
    }
    return best;
  }

  #channel(context: ContextKey, now: number): ChannelRec {
    const key = ctxKey(context);
    let rec = this.#channels.get(key);
    if (!rec) {
      rec = { context: { ...context }, lines: [], lively: false, her_last_at: null, touched: now };
      this.#channels.set(key, rec);
      this.#evict();
    }
    rec.touched = now;
    return rec;
  }

  #evict(): void {
    const max = Math.max(this.config.max_channels, 1);
    if (this.#channels.size <= max) return;
    const oldest = [...this.#channels.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (const [key] of oldest.slice(0, this.#channels.size - max)) this.#channels.delete(key);
  }

  #prune(rec: ChannelRec, now: number): void {
    const windowMs = this.config.activity_window_secs * 1000;
    const keep = rec.lines.findIndex((l) => now - l.at < windowMs);
    if (keep === -1) rec.lines = [];
    else if (keep > 0) rec.lines.splice(0, keep);
  }

  #voiceLines(context: ContextKey, now: number): VoiceLines {
    const key = voiceKey(context.platform, context.scope ?? "", context.channel);
    let rec = this.#voiceTalk.get(key);
    if (!rec) {
      rec = { lines: [], her_last_at: null, touched: now, lulled: false };
      this.#voiceTalk.set(key, rec);
      const max = Math.max(this.config.max_channels, 1);
      if (this.#voiceTalk.size > max) {
        const oldest = [...this.#voiceTalk.entries()].sort((a, b) => a[1].touched - b[1].touched);
        for (const [k] of oldest.slice(0, this.#voiceTalk.size - max)) this.#voiceTalk.delete(k);
      }
    }
    rec.touched = now;
    return rec;
  }

  #pruneVoice(rec: VoiceLines, now: number): void {
    const windowMs = this.config.voice_activity_window_secs * 1000;
    const keep = rec.lines.findIndex((l) => now - l.at < windowMs);
    if (keep === -1) rec.lines = [];
    else if (keep > 0) rec.lines.splice(0, keep);
  }

  #isLively(rec: ChannelRec): boolean {
    const authors = new Set(rec.lines.map((l) => l.author));
    return (
      rec.lines.length >= this.config.lively_messages && authors.size >= this.config.lively_authors
    );
  }

  #activity(rec: ChannelRec, now: number): ChannelActivity {
    const windowMs = this.config.activity_window_secs * 1000;
    const lines = rec.lines.filter((l) => now - l.at < windowMs);
    const authors: string[] = [];
    for (const l of [...lines].reverse()) {
      if (!authors.includes(l.author)) authors.push(l.author);
    }
    const last = rec.lines.at(-1)?.at ?? null;
    const minutes = Math.max(windowMs / 60_000, 1);
    return {
      context: { ...rec.context },
      recent_messages: lines.length,
      per_minute: Math.round((lines.length / minutes) * 100) / 100,
      last_at: last === null ? null : toTimestamp(last),
      recent_authors: authors.slice(0, 8),
      topic: topicWords(
        lines.slice(-TOPIC_LINES).map((l) => l.text),
        5,
      ),
      lively: rec.lively,
      her_last_at: rec.her_last_at === null ? null : toTimestamp(rec.her_last_at),
    };
  }
}

function affinityWeight(att: Attitude | null): number {
  return att ? Math.min(Math.max(att.affinity / 100, 0), 1) : 0;
}

function describeActivity(a: PresenceActivity, now: number): string | null {
  const since = a.started_at ? Date.parse(a.started_at) : Number.NaN;
  const forHow = Number.isNaN(since) ? "" : ` ${durationText(now - since)}`;
  switch (a.type) {
    case "playing":
      return a.name ? `在玩 ${oneLine(a.name, 32)}${forHow}` : null;
    case "listening": {
      if (a.details) {
        const by = a.state ? ` - ${oneLine(a.state, 24)}` : "";
        return `在聽 ${oneLine(a.name, 16)}:${oneLine(a.details, 32)}${by}`;
      }
      return a.name ? `在聽 ${oneLine(a.name, 32)}` : null;
    }
    case "streaming":
      return `在直播${a.details ? ` ${oneLine(a.details, 32)}` : ""}`;
    case "watching":
      return a.name ? `在看 ${oneLine(a.name, 32)}` : null;
    case "competing":
      return a.name ? `在比賽 ${oneLine(a.name, 32)}` : null;
    case "custom": {
      const text = [a.details, a.name].filter((x) => x).join(" ");
      return text ? `自訂狀態「${oneLine(text, 40)}」` : null;
    }
  }
}

/**
 * A person as she sees them: what they are doing. Not their status: online / idle /
 * do-not-disturb are habits more than signals, and she read a row of them as "keep quiet".
 */
function describePerson(p: PersonPresence, now: number): string {
  const parts: string[] = [];
  for (const a of p.activities) {
    const text = describeActivity(a, now);
    if (text) parts.push(text);
  }
  const name = oneLine(p.display_name, 24);
  return parts.length > 0 ? `${name}(${parts.join(",")})` : name;
}

const voiceKey = (platform: string, guild: string, channel: string) =>
  `${platform}:${guild}:${channel}`;

/** `正在聊天:最近 5 分鐘 12 句(Owen、阿明),最後一句 8 秒前` / `最近 5 分鐘沒人說話`. */
export function describeVoice(a: VoiceActivity, windowMins = 5): string {
  if (a.recent_utterances === 0 || a.secs_since_last === null) {
    return `最近 ${windowMins} 分鐘沒人說話`;
  }
  const names = a.recent_speakers.slice(0, 4).map((n) => oneLine(n, 16));
  const who = names.length > 0 ? `(${names.join("、")})` : "";
  const last =
    a.secs_since_last < 60
      ? `${a.secs_since_last} 秒前`
      : `${Math.round(a.secs_since_last / 60)} 分鐘前`;
  const head = a.lively ? "正在聊天:" : "";
  return `${head}最近 ${windowMins} 分鐘 ${a.recent_utterances} 句${who},最後一句 ${last}`;
}

function describeChannel(c: ChannelActivity): string {
  const parts = [`最近 ${c.recent_messages} 則`];
  if (c.lively) parts.push("很熱鬧");
  if (c.topic.length > 0) parts.push(`常出現:${c.topic.map((w) => oneLine(w, 16)).join("、")}`);
  return parts.join(",");
}
