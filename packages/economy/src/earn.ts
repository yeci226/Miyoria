// What people earn by being with her, read off the bus:
//
// * `talked`: once per local day she saw them say something, in text or in voice.
// * `voice`: per 10-minute window in her voice channel, when they spoke in it and are still
//   there when it ends (sitting in silence earns nothing).
// * `song`: a song they requested that she sang to the end.
// * the daily quest "hear a song" (quests.ts): whoever was in her voice channel when a song
//   started and still is when she sang it to the end.
//
// Only people she knows earn (`EconomyService.earn` checks); keys make a replayed event or a
// restart pay nothing twice.

import { errorMessage, type Logger, type ServiceLookup } from "@miyoria/kernel";
import { SingerKey } from "@miyoria/sing";
import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  contextKeyEquals,
  type Event,
  parseSongCue,
  SONG_TOPIC,
  type VoiceParticipant,
} from "@miyoria/types";
import type { EconomyConfig } from "./config.js";
import { type EconomyService, localDay, voiceWindow } from "./economy.js";

/** A stranger is looked up again after this long. */
const STRANGER_RETRY_MS = 10 * 60_000;
const MAX_REMEMBERED = 10_000;

interface Voice {
  context: ContextKey;
  present: Map<string, AccountRef>;
}

export class Earnings {
  readonly #economy: EconomyService;
  readonly #config: EconomyConfig;
  readonly #services: ServiceLookup;
  readonly #log: Logger;
  readonly #self = new Set<string>();
  /** Account → the local day `talked` was settled for them. */
  readonly #talked = new Map<string, number>();
  /** Account → when to look a stranger up again. */
  readonly #strangers = new Map<string, number>();
  #voice: Voice | null = null;
  /** Who was in her voice channel when the song now playing started. */
  #listening = new Map<string, AccountRef>();
  #window = -1;
  /** Who spoke in `#window`. */
  readonly #spoke = new Map<string, AccountRef>();

  constructor(
    economy: EconomyService,
    config: EconomyConfig,
    services: ServiceLookup,
    log: Logger,
  ) {
    this.#economy = economy;
    this.#config = config;
    this.#services = services;
    this.#log = log;
  }

  /** One bus event at `now` (epoch ms). Never throws. */
  async onEvent(event: Event, now: number): Promise<void> {
    try {
      await this.#on(event, now);
    } catch (error) {
      this.#log.warn({ err: errorMessage(error), event: event.type }, "cannot pay for an event");
    }
  }

  async #on(event: Event, now: number): Promise<void> {
    switch (event.type) {
      case "platform_ready":
        this.#self.add(accountRefString(event.data.self_account));
        return;
      case "platform_message_created": {
        const author = event.data.author;
        if (!author.is_bot) await this.#saw(author.account, now);
        return;
      }
      case "voice_joined":
        this.#voice = {
          context: event.data.context,
          present: this.#present(event.data.participants),
        };
        return;
      case "voice_participants":
        if (this.#voice === null || contextKeyEquals(this.#voice.context, event.data.context)) {
          this.#voice = {
            context: event.data.context,
            present: this.#present(event.data.participants),
          };
        }
        return;
      case "voice_left":
        if (this.#voice !== null && contextKeyEquals(this.#voice.context, event.data.context)) {
          this.#voice = null;
        }
        return;
      case "voice_utterance": {
        const speaker = event.data.speaker;
        if (speaker.is_bot || this.#isSelf(speaker.account)) return;
        await this.settleVoice(now);
        this.#spoke.set(accountRefString(speaker.account), speaker.account);
        await this.#saw(speaker.account, now);
        return;
      }
      case "custom":
        if (event.data.topic === SONG_TOPIC) await this.#song(event.data.payload);
        return;
      default:
        return;
    }
  }

  #isSelf(account: AccountRef): boolean {
    return this.#self.has(accountRefString(account));
  }

  #present(participants: readonly VoiceParticipant[]): Map<string, AccountRef> {
    const out = new Map<string, AccountRef>();
    for (const p of participants) {
      if (!p.is_self) out.set(accountRefString(p.account), p.account);
    }
    return out;
  }

  /** She saw them say something: `talked`, once a day. */
  async #saw(account: AccountRef, now: number): Promise<void> {
    if (this.#isSelf(account)) return;
    const key = accountRefString(account);
    const day = localDay(now, this.#config.utc_offset_minutes);
    if (this.#talked.get(key) === day || (this.#strangers.get(key) ?? 0) > now) return;
    if ((await this.#economy.member(account)) === null) {
      this.#remember(this.#strangers, key, now + STRANGER_RETRY_MS);
      return;
    }
    this.#strangers.delete(key);
    this.#remember(this.#talked, key, day);
    await this.#economy.earn(account, "talked", this.#config.talked, `talked:${day}`);
  }

  #remember(map: Map<string, number>, key: string, value: number): void {
    if (map.size >= MAX_REMEMBERED) map.clear();
    map.set(key, value);
  }

  /**
   * Pays the voice window that ended before `now`: whoever spoke in it and is still in her voice
   * channel (everyone who spoke, when who is there is unknown).
   */
  async settleVoice(now: number): Promise<void> {
    const window = voiceWindow(now);
    if (window === this.#window) return;
    const ended = this.#window;
    const spoke = [...this.#spoke.values()];
    this.#window = window;
    this.#spoke.clear();
    if (ended < 0) return;
    const present = this.#voice?.present ?? null;
    for (const account of spoke) {
      if (present !== null && !present.has(accountRefString(account))) continue;
      await this.#economy.earn(account, "voice", this.#config.voice_per_10min, `voice:${ended}`);
    }
  }

  /** The song was sung to the end: whoever sat through it ticks the daily quest. */
  async #heard(): Promise<void> {
    const stayed = [...this.#listening].filter(([key]) => this.#voice?.present.has(key));
    this.#listening = new Map();
    for (const [, account] of stayed) {
      const who = await this.#economy.member(account);
      if (who) await this.#economy.v2.questDone(who, "listen_song");
    }
  }

  /** A song ended: its requester earns when she sang it to the end. */
  async #song(payload: Parameters<typeof parseSongCue>[0]): Promise<void> {
    const cue = parseSongCue(payload);
    if (cue?.state === "started") this.#listening = new Map(this.#voice?.present ?? []);
    if (cue?.state !== "ended" || cue.outcome !== "finished") return;
    await this.#heard();
    const list = this.#services.get(SingerKey)?.list.all() ?? [];
    const entry = list
      .filter((e) => e.song?.id === cue.song && e.requester !== null && e.state === "done")
      .sort((a, b) => b.no - a.no)[0];
    if (!entry?.requester) return;
    const title = [...(entry.song?.title || entry.query)].slice(0, 100).join("");
    const paid = await this.#economy.earn(
      entry.requester,
      "song",
      this.#config.song_finished,
      `song:${entry.no}:${entry.created_at}`,
      title,
    );
    if (paid === null) return;
    const who = await this.#economy.member(entry.requester);
    if (who) await this.#economy.v2.afterEarn(who);
  }
}
