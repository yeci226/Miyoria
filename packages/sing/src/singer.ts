// The singing flow (docs/design/autonomy.md §22):
//
//   request ── worker job ──► preparing ──► ready ──► (she decides / forced) ──► playing ──► done
//
// * A request (her `sing_request` tool, `/queue song request`, a called `[modules.queue]` item
//   of kind `song`) adds a set list entry and submits a worker job; she keeps talking meanwhile.
// * Ready: songs asked for by command or the queue are sung as soon as she is in voice and free
//   (forced). Others are offered to her mind (`MindKey.suggest`), which picks the moment with a
//   `sing.play` intent and an opening line; she is reminded a couple of times, and her turns see
//   the set list (prompt section `sing`). Without a mind, ready songs start on their own.
// * Before a song starts she finishes what she is saying (the turn that started it, then a quiet
//   moment). While it plays the module holds her voice channel (`VoiceFloorKey`: her speech there
//   is dropped instead of queueing behind the song), barge-in does not apply (it is not her
//   speech), and only `sing.stop` (skip / stop) ends it early.
// * After a song that played to the end she is told, so she can say something about it.
// * When the worker takes the whole GPU to convert (its TTS / ASR go away for a minute or two),
//   she first says she is off to prepare it, and only then does the worker go ahead
//   (`exclusive: "waiting"` → `goExclusive`). Meanwhile speech is paused (`SpeechPauseKey`,
//   `SPEECH_PAUSE_TOPIC`): the voice module neither speaks nor transcribes, the overlay says so.
// * The song being prepared, its worker stage and progress are published as
//   `SONG_PREPARE_TOPIC` whenever they change (the overlay's activity line).

import { randomUUID } from "node:crypto";
import { CapabilityError } from "@miyoria/actions";
import { errorMessage, getLogger, type ModuleContext } from "@miyoria/kernel";
import { type RequestQueue, RequestQueueKey } from "@miyoria/queue";
import { SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  ARBITER_IMPULSE_TOPIC,
  type ContextKey,
  contextKeyEquals,
  customEvent,
  type Event,
  isJsonObject,
  type JsonValue,
  MindKey,
  newImpulse,
  PlatformSinksKey,
  type PlaybackState,
  type SetlistLine,
  SONG_PREPARE_TOPIC,
  SONG_TOPIC,
  type SongCue,
  type SongPrepare,
  SPEECH_PAUSE_TOPIC,
  type SpeechPause,
  type SteerableTask,
  type SteerOutcome,
  safeName,
  sameAccount,
  type TaskId,
  type TaskSteer,
  type TurnId,
  timestampMs,
  toTimestamp,
  type VoiceFloor,
  VoicePlayerKey,
  v2Event,
  WorldStateKey,
} from "@miyoria/types";
import {
  type GpuContext,
  type SingWorker,
  SingWorkerError,
  type SongMeta,
  type SongQuery,
  type WorkerJob,
} from "./client.js";
import type { SingConfig } from "./config.js";
import { LyricsCard } from "./lyrics-card.js";
import { dedicationProblem, type SongPayments, SongPaymentsKey } from "./payments.js";
import { singSong, sleep } from "./player.js";
import {
  askedName,
  type BackingMode,
  dedicationNote,
  LINK,
  type NewSong,
  SetList,
  type SongEntry,
  type SongNo,
  songLabel,
} from "./setlist.js";
import { parseSongPatch, songNo } from "./steer.js";

const log = getLogger("sing");

const TICK_MS = 100;
/** Settings key (profile `_global`) of the stored set list. */
export const SETLIST_KEY = "sing:setlist";
const STORE_PROFILE = "_global";
/** After a song is started without a turn, she gets this long to start an opening line. */
const EXPECT_OPENING_MS = 6000;
const TURNS_REMEMBERED = 64;

/** An announcement no longer makes sense after this. */
const ANNOUNCE_TTL_MS = 2 * 60_000;

/** Initiative / mind suggestion reasons. */
export const REASONS = {
  ready: "song_ready",
  start: "song_start",
  done: "song_done",
  failed: "song_failed",
  prepare: "song_prepare",
} as const;

export class SingError extends CapabilityError {
  override readonly name = "SingError";
}

/** A request: what to look for, and who asked. */
export interface SongRequest
  extends Omit<NewSong, "query" | "ticket_entry" | "dedication" | "dedication_entry"> {
  query: string;
  /** Buy a ticket if (and only if) the requester is at the per-person limit. */
  ticket?: boolean;
  /** A paid dedication (screened and charged here); needs a requester. */
  dedication?: string | null;
}

/** Topic of the stream overlay's screen line (the economy's `SCREEN_TOPIC`, kept as text here). */
const SCREEN_TOPIC = "economy.screen";

/**
 * The worker request for a set list query: a link (anywhere in it, e.g. 「唱這首 https://…」),
 * `library:<path>`, or a search.
 */
export function workerQuery(query: string, key: number, backing: BackingMode = "keep"): SongQuery {
  const q = query.trim();
  const link = LINK.exec(q)?.[0];
  // Only the exception is sent: the worker keeps the backing voices by default.
  const extra = backing === "keep" ? {} : { backing };
  if (link !== undefined) return { url: link, key, ...extra };
  if (q.toLowerCase().startsWith("library:")) return { path: q.slice(8).trim(), key, ...extra };
  return { query: q, key, ...extra };
}

interface Playing {
  entry: SongEntry;
  guild: string;
  stop: AbortController;
  /** The song itself started streaming (before that she is still saying her opening). */
  audible: boolean;
  /** Its lyrics card, when there is one. */
  card: LyricsCard | null;
}

/** She was told she is off to prepare a song; the worker waits for her to finish saying so. */
interface Preparing {
  no: SongNo;
  job: string;
  guild: string | null;
  asked_at: number;
  spoke: boolean;
  quiet_since: number | null;
}

/** Without a word from her this long after the notice, the worker goes ahead anyway. */
const EXPECT_NOTICE_MS = 8000;
/** Worker `exclusive` states during which speech is off. */
const GPU_TAKEN = new Set(["offloading", "active", "reloading"]);

/**
 * Votes needed to skip with `listeners` people listening: `ratio` of them rounded up, at least
 * `min`, but never more than everyone listening (someone alone with her skips with one vote).
 */
export function skipVotesNeeded(listeners: number, ratio: number, min: number): number {
  const people = Math.max(listeners, 1);
  return Math.min(Math.max(min, Math.ceil(people * ratio)), people);
}

/** The outcome of one `voteSkip`. */
export interface SkipVote {
  entry: SongEntry;
  votes: number;
  needed: number;
  /** False when this person had already voted. */
  counted: boolean;
  skipped: boolean;
}

export class Singer implements VoiceFloor, SpeechPause {
  readonly list: SetList;
  #playing: Playing | null = null;
  /** Song number -> who voted to skip it. */
  readonly #skipVotes = new Map<SongNo, Set<string>>();
  /** Voice channels she is in. */
  #voices: ContextKey[] = [];
  /** Where she last sent a message, per `platform:guild` (the lyrics card goes there). */
  readonly #lastTyped = new Map<string, ContextKey>();
  /** Her speech playbacks running per guild. */
  readonly #speaking = new Map<string, number>();
  readonly #turnsDone: TurnId[] = [];
  #closed = false;
  /** JSON of the set list last stored. */
  #saved: string | null = null;
  /** Restored songs that never reached the worker. */
  readonly #orphans = new Set<SongNo>();
  /** Songs whose job has (or is about to have) the GPU, by number. */
  readonly #gpu = new Set<SongNo>();
  #preparing: Preparing | null = null;
  /** Jobs told to go ahead that may still report `waiting` for a poll. */
  readonly #told = new Set<string>();
  #lastNotice = Number.NEGATIVE_INFINITY;
  #paused = false;
  /** What the worker last said about preparing songs (not stored). */
  readonly #jobs = new Map<SongNo, { title: string; exclusive: string | null }>();
  /** JSON of the `SONG_PREPARE_TOPIC` payload last published. */
  #prepareSent = JSON.stringify(NOT_PREPARING);

  /**
   * `videoDir`: the worker's cache dir (absolute) when song videos are shown on stream
   * (`[modules.sing] video`), else `null`.
   */
  constructor(
    private readonly cfg: SingConfig,
    private readonly ctx: ModuleContext,
    private readonly worker: SingWorker,
    private readonly videoDir: string | null = null,
  ) {
    this.list = new SetList(cfg);
  }

  // ----- views -----

  /** `SpeechPause`: speech is off while a song's job has the GPU. */
  paused(): string | null {
    return this.#paused ? "song" : null;
  }

  holder(guild: string): string | null {
    const p = this.#playing;
    return p?.audible && p.guild === guild ? "song" : null;
  }

  playing(): SongEntry | null {
    return this.#playing?.entry ?? null;
  }

  /** `VoiceFloor`: songs still to sing in `guild` (a song asked for outside a server counts too). */
  pending(guild: string): number {
    return this.list.open().filter((e) => e.context === null || e.context.scope === guild).length;
  }

  /** `VoiceFloor`: the songs of `pending`, by the numbers she sings them with. */
  setlist(guild: string): SetlistLine[] {
    return this.list
      .open()
      .filter((e) => e.state !== "playing" && (e.context === null || e.context.scope === guild))
      .map((e) => ({ no: e.no, label: songLabel(e), ready: e.state === "ready" }));
  }

  /** The song started is waiting for her to finish talking. */
  starting(): boolean {
    return this.#playing !== null && !this.#playing.audible;
  }

  /** A voice channel she is in (in `guild` when given). */
  voiceContext(guild: string | null = null): ContextKey | null {
    return this.#voices.find((v) => guild === null || v.scope === guild) ?? null;
  }

  // ----- requests -----

  /** Adds a song and starts preparing it; resolves once the worker took the job. */
  async request(req: SongRequest, signal?: AbortSignal): Promise<SongEntry> {
    const query = req.query.trim();
    if (query === "") throw new SingError("no song name given");
    if ([...query].length > this.cfg.max_query_chars) {
      throw new SingError(`the song name is longer than ${this.cfg.max_query_chars} characters`);
    }
    const same = this.list.findOpen(query, req.key, req.backing ?? "keep");
    if (same) {
      if (req.forced) same.forced = true;
      return same;
    }
    const { ticket, dedication, ...plain } = req;
    const dedicationText = dedication?.trim() || null;
    if (dedicationText !== null) {
      const problem = dedicationProblem(dedicationText);
      if (problem !== null) throw new SingError(problem);
    }
    const paid = await this.#charge(req, query, ticket === true, dedicationText);
    let entry: SongEntry;
    try {
      entry = this.list.add({ ...plain, query, ...paid.fields }, toTimestamp(this.ctx.clock.now()));
    } catch (error) {
      await this.#refundAll(req.requester, paid.entries);
      const hint =
        req.requester !== null && this.list.atUserLimit(req.requester) && ticket !== true
          ? this.#payments() !== null
            ? "。想多點一首可以用指令 /queue song request 加上點歌加點券(ticket)"
            : ""
          : "";
      throw new SingError(`${errorMessage(error)}${hint}`, { cause: error });
    }
    try {
      const job = await this.worker.submit(this.#query(query, req.key, entry.backing), signal);
      entry.job = job.id;
      this.#apply(entry, job);
      this.#publishPrepare();
    } catch (error) {
      // The caller hears about it from the error; no separate notice.
      this.#fail(entry, errorMessage(error), false);
      throw new SingError(`could not ask the song worker: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    return entry;
  }

  #payments(): SongPayments | null {
    return this.ctx.services.get(SongPaymentsKey) ?? null;
  }

  /**
   * Charges what a request asked to pay for: a ticket (only when the requester is at the limit)
   * and a dedication. Throws a `SingError` with the reason when it cannot; a charge made is
   * refunded when a later one fails.
   */
  async #charge(
    req: SongRequest,
    query: string,
    wantsTicket: boolean,
    dedication: string | null,
  ): Promise<{
    fields: { ticket_entry?: string; dedication?: string; dedication_entry?: string };
    entries: string[];
  }> {
    const fields: { ticket_entry?: string; dedication?: string; dedication_entry?: string } = {};
    const entries: string[] = [];
    const who = req.requester;
    const needsTicket = wantsTicket && who !== null && this.list.atUserLimit(who);
    if (!needsTicket && dedication === null) return { fields, entries };
    const payments = this.#payments();
    if (who === null || payments === null) {
      throw new SingError(
        needsTicket ? "點歌加點券現在不能用" : "獻詞現在不能用(要有帳號和經濟系統)",
      );
    }
    const nonce = `${this.ctx.clock.now()}:${randomUUID()}`;
    const ref = `song:${safeName(query, 60)}`;
    try {
      if (needsTicket) {
        const r = await payments.charge(who, "song_ticket", `${nonce}:ticket`, ref);
        if ("refused" in r) throw new SingError(r.refused);
        fields.ticket_entry = r.entryId;
        entries.push(r.entryId);
      }
      if (dedication !== null) {
        const r = await payments.charge(who, "dedication", `${nonce}:ded`, ref, dedication);
        if ("refused" in r) throw new SingError(r.refused);
        fields.dedication = dedication;
        fields.dedication_entry = r.entryId;
        entries.push(r.entryId);
      }
    } catch (error) {
      await this.#refundAll(who, entries);
      throw error;
    }
    return { fields, entries };
  }

  async #refundAll(who: AccountRef | null, entries: string[]): Promise<void> {
    const payments = this.#payments();
    if (who === null || payments === null) return;
    for (const id of entries) {
      try {
        await payments.refund(who, id);
      } catch (error) {
        log.warn({ err: errorMessage(error) }, "could not refund a song charge");
      }
    }
  }

  /** The song was not sung to its end: gives back the ticket and the dedication, once each. */
  #release(entry: SongEntry): void {
    const ids = [entry.ticket_entry, entry.dedication_entry].filter((x): x is string => !!x);
    entry.ticket_entry = null;
    entry.dedication_entry = null;
    if (ids.length > 0) void this.#refundAll(entry.requester, ids);
  }

  #query(query: string, key: number, backing: BackingMode = "keep"): SongQuery {
    return { ...workerQuery(query, key, backing), exclusive_ack: this.cfg.prepare_notice };
  }

  /** Worker job state → entry. */
  #apply(entry: SongEntry, job: WorkerJob): void {
    if (entry.state !== "preparing") return;
    entry.stage = job.stage;
    entry.progress = job.progress;
    this.#jobs.set(entry.no, {
      title: job.song?.title.trim() || job.source?.title.trim() || "",
      exclusive: job.exclusive,
    });
    this.#onExclusive(entry, job);
    switch (job.state) {
      case "done":
        if (!job.song) {
          this.#fail(entry, "the worker finished without a song");
          return;
        }
        entry.song = job.song;
        entry.state = "ready";
        entry.progress = 1;
        entry.ready_at = toTimestamp(this.ctx.clock.now());
        log.info({ no: entry.no, song: job.song.id, cached: job.cached }, "song ready");
        this.#onReady(entry);
        return;
      case "failed":
      case "cancelled":
        this.#fail(entry, job.error ?? job.state);
        return;
      default:
        return;
    }
  }

  // ----- the GPU to the worker -----

  #onExclusive(entry: SongEntry, job: WorkerJob): void {
    const ex = job.exclusive;
    if (ex === "waiting") {
      if (this.#preparing?.job !== job.id && !this.#told.has(job.id)) this.#announce(entry, job.id);
    } else if (ex !== null && GPU_TAKEN.has(ex)) {
      this.#gpu.add(entry.no);
      if (this.#preparing?.job === job.id) this.#preparing = null;
    } else {
      this.#gpu.delete(entry.no);
      if (this.#preparing?.job === job.id) this.#preparing = null;
    }
    if (ex !== "waiting") this.#told.delete(job.id);
    if (job.state !== "queued" && job.state !== "running") this.#gpu.delete(entry.no);
    this.#updatePause();
  }

  /** The worker waits to take the GPU: she says she is off to prepare it, unless she just did. */
  #announce(entry: SongEntry, job: string): void {
    const now = this.ctx.clock.now();
    const where = this.voiceContext(entry.context?.scope ?? null) ?? this.voiceContext();
    const recent = now - this.#lastNotice < this.cfg.prepare_notice_gap_secs * 1000;
    if (where === null || this.#closed) {
      this.#go(entry.no, job);
      return;
    }
    if (recent) {
      // Nothing to announce, but what she is saying right now gets to end (§13.6: on 11-07 the
      // offload cut a sentence of hers in two).
      if ((this.#speaking.get(where.scope ?? "") ?? 0) === 0) {
        this.#go(entry.no, job);
        return;
      }
      this.#preparing = {
        no: entry.no,
        job,
        guild: where.scope,
        asked_at: now,
        spoke: true,
        quiet_since: null,
      };
      return;
    }
    this.#lastNotice = now;
    this.#preparing = {
      no: entry.no,
      job,
      guild: where.scope,
      asked_at: now,
      spoke: false,
      quiet_since: null,
    };
    this.#tell(
      where,
      REASONS.prepare,
      `你要去準備${songLabel(entry)}了:接下來一兩分鐘顯示卡要拿去做歌,你會暫時不能說話,也聽不到大家。` +
        "現在用一句很短的話跟大家說(例如「我去準備一下歌喔」),說完就開始。",
      entry,
    );
  }

  /** She said it (or did not in time): the worker takes the GPU. */
  #go(no: SongNo, job: string): void {
    if (this.#preparing?.job === job) this.#preparing = null;
    this.#told.add(job);
    this.#gpu.add(no);
    this.#updatePause();
    void this.worker
      .goExclusive(job)
      .catch((error: unknown) =>
        log.debug({ no, err: errorMessage(error) }, "could not tell the worker to go ahead"),
      );
  }

  /** Waits for her notice to be said: she spoke and is quiet again, or she did not start. */
  #checkPreparing(now: number): void {
    const p = this.#preparing;
    if (p === null) return;
    const talking = p.guild !== null && (this.#speaking.get(p.guild) ?? 0) > 0;
    if (talking) {
      p.spoke = true;
      p.quiet_since = null;
    } else if (p.spoke) {
      p.quiet_since ??= now;
    }
    const said = p.spoke && p.quiet_since !== null && now - p.quiet_since >= this.cfg.quiet_ms;
    const silent = !p.spoke && now - p.asked_at >= EXPECT_NOTICE_MS;
    const late = now - p.asked_at >= this.cfg.announce_max_secs * 1000;
    if (said || silent || late) this.#go(p.no, p.job);
  }

  #updatePause(): void {
    for (const no of this.#gpu) {
      if (this.list.get(no)?.state !== "preparing") this.#gpu.delete(no);
    }
    const paused = this.#gpu.size > 0 && !this.#closed;
    if (paused === this.#paused) return;
    this.#paused = paused;
    log.info({ paused }, paused ? "speech paused: the song worker has the GPU" : "speech is back");
    this.ctx.publish(
      customEvent(SPEECH_PAUSE_TOPIC, { paused, reason: paused ? "song" : null } as JsonValue),
    );
  }

  #fail(entry: SongEntry, why: string, tell = true): void {
    if (entry.state !== "preparing" && entry.state !== "ready") return;
    log.info({ no: entry.no, why }, "song failed");
    this.list.finish(entry, "failed", why);
    this.#release(entry);
    this.#finishQueueItem(entry, false);
    const where = entry.context ?? this.voiceContext();
    if (tell && where !== null && entry.requester !== null) {
      this.#tell(
        where,
        REASONS.failed,
        `${entry.requester_name} 點的${songLabel(entry)}沒有準備成功(${safeName(why, 120)})。跟對方說一聲。`,
        entry,
      );
    }
  }

  // ----- the moment to sing -----

  /** The game she is playing, if any. */
  #game(): string | null {
    return this.ctx.services.get(WorldStateKey)?.snapshot().her.game ?? null;
  }

  #mindDecides(entry: SongEntry): boolean {
    if (this.cfg.start === "auto") return false;
    const gaming = this.#game() !== null;
    // An owner's command overrides; a request from the queue waits while she plays.
    if (entry.forced && !(gaming && entry.queue_item !== null)) return false;
    if (gaming) {
      // She picks the moment, but someone is waiting: after a while it starts anyway.
      const since = timestampMs(entry.ready_at ?? entry.created_at);
      if (this.ctx.clock.now() - since >= this.cfg.busy_max_wait_mins * 60_000) return false;
    } else if (entry.reminders > this.cfg.max_reminders) {
      // She let every reminder pass: someone is still waiting for it, so it starts on its own.
      return false;
    }
    return this.ctx.services.get(MindKey)?.accepting === true;
  }

  #onReady(entry: SongEntry): void {
    if (!this.#mindDecides(entry)) {
      this.#autoStart();
      return;
    }
    this.#remind(entry);
  }

  /** Tells her mind the song is ready (again). */
  #remind(entry: SongEntry): void {
    const mind = this.ctx.services.get(MindKey);
    const where = this.voiceContext(entry.context?.scope ?? null) ?? entry.context;
    entry.reminders += 1;
    entry.last_reminder_ms = this.ctx.clock.now();
    const voice = this.voiceContext() === null ? "你現在不在語音頻道,要唱得先進語音。" : "";
    const game = this.#game();
    const busy =
      game === null
        ? ""
        : `你正在玩 ${game}:想先唱就唱(唱完再回去玩),想先玩完就跟${entry.requester_name}說一聲等一下。`;
    const hint =
      `${entry.requester_name} 點的${songLabel(entry)}已經準備好了(#${entry.no}${dedicationNote(entry)})。` +
      `想唱就用 sing.play(song = ${entry.no}),opening 寫一句開場;現在不想唱也可以晚點再唱。${voice}${busy}`;
    const ok = mind?.suggest({
      source: "sing",
      reason: REASONS.ready,
      context: where,
      hint,
      about: entry.requester ? [entry.requester] : [],
    });
    if (!ok) this.#autoStart();
  }

  /** Starts the next song that should start on its own, when she is in voice and free. */
  #autoStart(): void {
    if (this.#playing || this.#closed) return;
    const next = this.list.ready().find((e) => !this.#mindDecides(e));
    if (!next) return;
    const where = this.voiceContext(next.context?.scope ?? null) ?? this.voiceContext();
    if (where === null || where.scope === null) return;
    this.#tell(
      where,
      REASONS.start,
      `你要開始唱${songLabel(next)}了(${next.requester_name} 點的${dedicationNote(next)})。用一句話開場,說完就開始。`,
      next,
    );
    this.#begin(next, where.scope, null, EXPECT_OPENING_MS);
  }

  /** Periodic work: reminders and songs that should start on their own. */
  tick(): void {
    const now = this.ctx.clock.now();
    this.#checkPreparing(now);
    this.#updatePause();
    const gaming = this.#game() !== null;
    for (const e of this.list.ready()) {
      if (!this.#mindDecides(e)) continue;
      const every = gaming ? this.cfg.busy_remind_secs : this.cfg.remind_secs;
      const due = (e.last_reminder_ms ?? now) + every * 1000;
      // The first notice plus `max_reminders` (while she plays, every few minutes until it
      // starts), only while she is in voice (she can sing then).
      const more = gaming || e.reminders <= this.cfg.max_reminders;
      if (more && now >= due && this.voiceContext() !== null) this.#remind(e);
    }
    this.#autoStart();
  }

  /**
   * Sings `no` (or the first ready song) in the voice channel of `context`'s guild. Returns the
   * entry once it is scheduled: it starts after `turn` (the turn asking for it) and a quiet moment.
   */
  play(no: SongNo | null, context: ContextKey | null, turn: TurnId | null): SongEntry {
    if (this.#playing) throw new SingError(`already singing ${songLabel(this.#playing.entry)}`);
    const entry = no === null ? (this.list.ready()[0] ?? null) : this.list.get(no);
    if (entry === null) {
      const preparing = this.list.preparing();
      throw new SingError(
        no === null
          ? preparing.length > 0
            ? `no song is ready yet (${preparing.length} preparing)`
            : "no song is ready; request one first"
          : `there is no song #${no}`,
      );
    }
    if (entry.state === "preparing") {
      throw new SingError(`song #${entry.no} is still being prepared (${pct(entry.progress)})`);
    }
    if (entry.state !== "ready") throw new SingError(`song #${entry.no} is ${entry.state}`);
    const guild = this.#guildFor(context);
    if (guild === null) throw new SingError("she is not in a voice channel");
    this.#begin(entry, guild, turn, 0);
    return entry;
  }

  #guildFor(context: ContextKey | null): string | null {
    const scope = context?.scope ?? null;
    const voice = this.ctx.services.get(VoicePlayerKey);
    if (!voice) throw new SingError("voice is not running");
    if (scope !== null && voice.channel(scope) !== null) return scope;
    const any = this.voiceContext();
    return any?.scope != null && voice.channel(any.scope) !== null ? any.scope : null;
  }

  #begin(entry: SongEntry, guild: string, turn: TurnId | null, expectMs: number): void {
    const stop = new AbortController();
    entry.state = "playing";
    this.#playing = { entry, guild, stop, audible: false, card: null };
    this.ctx.spawn(`song-${entry.no}`, async (signal) => {
      const both = AbortSignal.any([signal, stop.signal]);
      let outcome: PlaybackState | "error" = "interrupted";
      try {
        await this.#waitQuiet(guild, turn, expectMs, both);
        if (!both.aborted) outcome = await this.#sing(entry, guild, both);
      } catch (error) {
        log.warn({ no: entry.no, err: errorMessage(error) }, "could not sing");
        outcome = "error";
        entry.error = errorMessage(error);
      }
      this.#ended(entry, guild, outcome);
    });
  }

  async #sing(entry: SongEntry, guild: string, signal: AbortSignal): Promise<PlaybackState> {
    const voice = this.ctx.services.get(VoicePlayerKey);
    if (!voice) throw new SingError("voice is not running");
    const song = entry.song;
    if (!song) throw new SingError("the song has no audio");
    log.info({ no: entry.no, song: song.id, guild }, "singing");
    const card = this.#lyricsCard(song, guild);
    if (this.#playing?.entry === entry) {
      this.#playing.audible = true;
      this.#playing.card = card;
    }
    this.#showDedication(entry);
    return singSong(
      {
        worker: this.worker,
        voice,
        clock: this.ctx.clock,
        cue: (cue) => {
          this.#cue(cue);
          card?.onCue(cue);
        },
        leadMs: this.cfg.lead_ms,
        fadeMs: this.cfg.fade_ms,
        lyrics: this.cfg.lyrics,
        lipSyncVocals: this.cfg.lip_sync_vocals,
        videoDir: this.videoDir,
      },
      song,
      guild,
      signal,
    );
  }

  /** The dedication goes up on the overlay as the song starts. */
  #showDedication(entry: SongEntry): void {
    if (!entry.dedication || !entry.dedication_entry) return;
    const title = entry.song?.title?.trim() || entry.query;
    this.ctx.publish(
      customEvent(SCREEN_TOPIC, {
        kind: "dedication",
        name: safeName(entry.requester_name, 32),
        text: entry.dedication,
        song: safeName(title, 60),
      } as JsonValue),
    );
  }

  #ended(entry: SongEntry, guild: string, outcome: PlaybackState | "error"): void {
    const card = this.#playing?.entry === entry ? this.#playing.card : null;
    const wasAudible = this.#playing?.entry === entry && this.#playing.audible;
    if (this.#playing?.entry === entry) this.#playing = null;
    if (entry.song) {
      const cue: SongCue = { state: "ended", song: entry.song.id, outcome };
      this.#cue(cue);
      card?.onCue(cue);
    }
    const finished = outcome === "finished";
    this.list.finish(entry, finished || outcome === "interrupted" ? "done" : "failed", entry.error);
    // A song that was sung (to the end, or skipped once it was audible) keeps its charges.
    if (!wasAudible || !(finished || outcome === "interrupted")) this.#release(entry);
    this.#finishQueueItem(entry, finished);
    log.info({ no: entry.no, outcome }, "song ended");
    const where = this.voiceContext(guild);
    if (finished && where !== null && !this.#closed) {
      this.#tell(
        where,
        REASONS.done,
        `你剛唱完${songLabel(entry)}(${entry.requester_name} 點的)。想說的話可以說一句感想。`,
        entry,
      );
    }
    if (!this.#closed) this.#autoStart();
  }

  /**
   * One vote to skip the song she is singing (one per person). It is skipped once
   * `vote_skip_ratio` of the people listening in her voice channel voted (rounded up, at least
   * `vote_skip_min`, at most everyone listening); whoever requested it skips it alone. `null`
   * when nothing plays.
   */
  async voteSkip(voter: AccountRef): Promise<SkipVote | null> {
    const playing = this.#playing;
    if (!playing) return null;
    const entry = playing.entry;
    const votes = this.#skipVotes.get(entry.no) ?? new Set<string>();
    this.#skipVotes.set(entry.no, votes);
    const id = `${voter.platform}:${voter.id}`;
    const counted = !votes.has(id);
    votes.add(id);
    const listeners = this.#listeners(playing.guild);
    const needed = skipVotesNeeded(listeners, this.cfg.vote_skip_ratio, this.cfg.vote_skip_min);
    const own = entry.requester !== null && sameAccount(entry.requester, voter);
    const skipped = own || votes.size >= needed;
    if (skipped) {
      this.#skipVotes.delete(entry.no);
      await this.stop(false);
    }
    return { entry, votes: votes.size, needed, counted, skipped };
  }

  /** People in her voice channel of `guild` who can hear the song (not her, not deafened). */
  #listeners(guild: string): number {
    const where = this.voiceContext(guild);
    const world = this.ctx.services.get(WorldStateKey);
    if (!where || !world) return 1;
    const room = world
      .snapshot()
      .voice_channels.find((c) => c.guild === guild && c.channel === where.channel);
    return room?.members.filter((m) => !m.is_self && !m.deafened).length ?? 1;
  }

  /** Stops the song she is singing; `all` also drops every other song in the list. */
  /**
   * Stops the song she is singing and, with `all`, cancels the rest of the set list. With
   * `stopCurrent` false the song she is singing goes on to its end: only the rest is cancelled.
   */
  async stop(
    all: boolean,
    stopCurrent = true,
  ): Promise<{ stopped: SongEntry | null; dropped: number }> {
    const current = this.#playing;
    if (stopCurrent) current?.stop.abort();
    let dropped = 0;
    if (all) {
      for (const e of this.list.open()) {
        if (e === current?.entry) continue;
        if (e.job !== null && e.state === "preparing") {
          await this.worker.cancel(e.job).catch(() => undefined);
        }
        this.list.finish(e, "cancelled");
        this.#release(e);
        this.#finishQueueItem(e, false);
        dropped += 1;
      }
    }
    return { stopped: stopCurrent ? (current?.entry ?? null) : null, dropped };
  }

  // ----- steer: changing a song that has not started (v3 §10.6) -----

  /** `SteerRoute.live`: the song as a task while it is open (preparing or ready). */
  steerable(task: TaskId): SteerableTask | "over" | null {
    const no = songNo(task);
    const entry = no === null ? null : this.list.get(no);
    if (entry === null) return null;
    if (entry.state === "preparing" || entry.state === "ready") {
      return { goal: "sing", args: { song: entry.no, key: entry.key } };
    }
    return "over";
  }

  /**
   * Changes a song that has not started: where it stands in the list and/or its key. Between
   * songs only: one that is playing (or over) is too late. Answers at once with the outcome.
   */
  async steer(steer: TaskSteer): Promise<{ outcome: SteerOutcome; detail: string }> {
    const no = songNo(steer.task);
    const entry = no === null ? null : this.list.get(no);
    if (entry === null) return { outcome: "rejected", detail: "歌單上沒有這首歌" };
    const late = {
      outcome: "too_late" as const,
      detail: `#${entry.no} 已經${entry.state === "playing" ? "在唱" : "結束"}了,歌只能在歌與歌之間改`,
    };
    if (entry.state !== "preparing" && entry.state !== "ready") return late;
    const patch = parseSongPatch(steer.patch);
    if (typeof patch === "string") return { outcome: "rejected", detail: patch };
    const notes: string[] = [];
    if (patch.key !== undefined && patch.key !== entry.key) {
      const refused = await this.#rekey(entry, patch.key);
      if (refused !== null) return refused;
      notes.push(`key 改成 ${patch.key >= 0 ? "+" : ""}${patch.key},重新轉換`);
    } else if (patch.key !== undefined) {
      notes.push(`key 本來就是 ${patch.key}`);
    }
    if (patch.position !== undefined) {
      notes.push(`排到第 ${this.list.move(entry, patch.position)} 首`);
    }
    this.#publishPrepare();
    return { outcome: "applied", detail: `${songLabel(entry)}:${notes.join(",")}` };
  }

  /**
   * A new worker job for `entry` in `key`, the old one dropped. The key is baked into a worker
   * job when it starts (see steer.ts), so there is no changing it while a conversion runs; the
   * stems the worker already made are reused. The song keeps its place and what it was until the
   * new job is accepted, so a refusal loses nothing. `null`: done.
   */
  async #rekey(
    entry: SongEntry,
    key: number,
  ): Promise<{ outcome: "rejected" | "too_late"; detail: string } | null> {
    const same = this.list.findOpen(entry.query, key, entry.backing);
    if (same !== null && same !== entry) {
      return { outcome: "rejected", detail: `#${same.no} 已經是同一首歌(key ${key})` };
    }
    let job: WorkerJob;
    try {
      job = await this.worker.submit(this.#query(entry.query, key, entry.backing));
    } catch (error) {
      return { outcome: "rejected", detail: `問不到歌曲工作站:${errorMessage(error)}` };
    }
    // She started singing it (or it was dropped) while the worker took the job.
    if (entry.state !== "preparing" && entry.state !== "ready") {
      void this.worker.cancel(job.id).catch(() => undefined);
      return { outcome: "too_late", detail: `#${entry.no} 已經開始了,key 來不及改` };
    }
    const old = entry.job;
    if (entry.state === "preparing" && old !== null) {
      void this.worker.cancel(old).catch(() => undefined);
      this.#told.delete(old);
    }
    entry.key = key;
    entry.state = "preparing";
    entry.stage = "queued";
    entry.progress = 0;
    entry.error = null;
    entry.song = null;
    entry.ready_at = null;
    entry.reminders = 0;
    entry.last_reminder_ms = null;
    entry.job = job.id;
    this.#gpu.delete(entry.no);
    if (this.#preparing?.no === entry.no) this.#preparing = null;
    this.#apply(entry, job);
    this.#updatePause();
    return null;
  }

  // ----- her speech, so a song starts after she finished talking -----

  async #waitQuiet(
    guild: string,
    turn: TurnId | null,
    expectMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const clock = this.ctx.clock;
    const deadline = clock.now() + this.cfg.announce_max_secs * 1000;
    while (turn !== null && !this.#turnsDone.includes(turn) && clock.now() < deadline) {
      await sleep(TICK_MS, signal);
      if (signal.aborted) return;
    }
    const t0 = clock.now();
    let spoke = false;
    let quietSince: number | null = null;
    while (clock.now() < deadline && !signal.aborted) {
      const now = clock.now();
      if ((this.#speaking.get(guild) ?? 0) > 0) {
        spoke = true;
        quietSince = null;
      } else if (spoke || now - t0 >= expectMs) {
        quietSince ??= now;
        if (now - quietSince >= this.cfg.quiet_ms) return;
      }
      await sleep(TICK_MS, signal);
    }
  }

  // ----- events -----

  onEvent(event: Event): void {
    switch (event.type) {
      case "voice_joined": {
        const c = event.data.context;
        this.#voices = [c, ...this.#voices.filter((v) => !contextKeyEquals(v, c))];
        // Now she can sing: ready songs she decides about are brought up again.
        for (const e of this.list.ready()) {
          if (this.#mindDecides(e) && e.reminders <= this.cfg.max_reminders) this.#remind(e);
        }
        this.#autoStart();
        return;
      }
      case "voice_left": {
        const c = event.data.context;
        this.#voices = this.#voices.filter((v) => !contextKeyEquals(v, c));
        if (c.scope !== null) this.#speaking.delete(c.scope);
        return;
      }
      case "voice_playback": {
        const guild = event.data.context.scope;
        if (guild === null) return;
        const n = this.#speaking.get(guild) ?? 0;
        if (event.data.state === "started") this.#speaking.set(guild, n + 1);
        else this.#speaking.set(guild, Math.max(0, n - 1));
        return;
      }
      case "action_completed": {
        const c = event.data.message?.context;
        if (event.data.ok && c?.scope != null) this.#lastTyped.set(`${c.platform}:${c.scope}`, c);
        return;
      }
      case "agent_turn_completed":
        this.#turnsDone.push(event.data.turn);
        if (this.#turnsDone.length > TURNS_REMEMBERED) this.#turnsDone.shift();
        return;
      case "custom":
        if (event.data.topic === "queue.item_activated") this.#onQueueItem(event.data.payload);
        return;
      default:
        return;
    }
  }

  #onQueueItem(payload: JsonValue): void {
    if (!isJsonObject(payload) || payload.kind !== this.cfg.queue_kind) return;
    const item = payload.id;
    const text = payload.text;
    if (typeof item !== "number" || typeof text !== "string") return;
    const requester = accountOf(payload.requester);
    const name = typeof payload.requester_name === "string" ? payload.requester_name : "觀眾";
    const context = contextOf(payload.context);
    void this.request({
      query: text,
      key: 0,
      requester,
      requester_name: name,
      context,
      forced: true,
      queue_item: item,
    }).catch((error: unknown) => {
      log.warn({ item, err: errorMessage(error) }, "could not prepare a queued song");
      this.#queue((q) => q.skip(item));
    });
  }

  #finishQueueItem(entry: SongEntry, done: boolean): void {
    const item = entry.queue_item;
    if (item === null) return;
    entry.queue_item = null;
    this.#queue((q) => (done ? q.complete(item) : q.skip(item)));
  }

  #queue(fn: (q: RequestQueue) => unknown): void {
    const q = this.ctx.services.get(RequestQueueKey);
    if (!q) return;
    try {
      fn(q);
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "could not finish the queue item");
    }
  }

  // ----- polling the worker -----

  /**
   * Checks every preparing song once. A job the worker does not know (it restarted, or forgot
   * old jobs) is asked for again: a song it finished is in its cache and comes back at once.
   */
  async poll(signal?: AbortSignal): Promise<void> {
    if (this.list.preparing().length > 0) {
      // Without this the worker assumes people are listening, which is the careful answer.
      await this.worker
        .context(this.#gpuContext(), signal)
        .catch((e: unknown) => log.debug({ err: errorMessage(e) }, "could not update the worker"));
    }
    for (const entry of this.list.preparing()) {
      try {
        if (entry.job === null) {
          // Restored before the worker took it (a request in flight is not ours to repeat).
          if (this.#orphans.delete(entry.no)) await this.#resubmit(entry, signal);
          continue;
        }
        this.#apply(entry, await this.worker.job(entry.job, signal));
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof SingWorkerError && error.status === 404) {
          log.info({ no: entry.no, job: entry.job }, "the song worker lost the job; asking again");
          await this.#resubmit(entry, signal).catch((e: unknown) =>
            log.debug({ no: entry.no, err: errorMessage(e) }, "could not ask again"),
          );
          continue;
        }
        log.debug({ no: entry.no, err: errorMessage(error) }, "could not check a song job");
      }
    }
    this.#publishPrepare();
  }

  /** Who would notice her going quiet, and which songs are needed now. */
  #gpuContext(): GpuContext {
    const her = this.ctx.services.get(WorldStateKey)?.snapshot().her;
    let listeners = 0;
    for (const voice of this.#voices) {
      if (voice.scope !== null) listeners += this.#listeners(voice.scope);
    }
    const urgent: string[] = [];
    for (const e of this.list.preparing()) {
      if (e.forced && e.job !== null) urgent.push(e.job);
    }
    return {
      in_voice: this.#voices.length > 0,
      listeners,
      live: Boolean(her?.golive) || her?.streaming === true,
      urgent,
    };
  }

  /** Publishes the song being prepared (`SONG_PREPARE_TOPIC`) when it changed. */
  #publishPrepare(): void {
    const preparing = this.#closed ? [] : this.list.preparing();
    for (const no of this.#jobs.keys()) {
      if (!preparing.some((e) => e.no === no)) this.#jobs.delete(no);
    }
    // The one furthest along: a job the worker runs before the queued ones.
    const rank = (e: SongEntry) => (e.stage !== "queued" && e.stage !== "" ? 1 : 0) + e.progress;
    let best: SongEntry | null = null;
    for (const e of preparing) if (best === null || rank(e) > rank(best)) best = e;
    let payload: SongPrepare = NOT_PREPARING;
    if (best !== null) {
      const info = this.#jobs.get(best.no);
      // A link or a library path is no title; the worker's comes once it found the song.
      payload = {
        no: best.no,
        title: info?.title || askedName(best.query),
        stage: best.stage,
        progress: Math.round(Math.min(Math.max(best.progress, 0), 1) * 1000) / 1000,
        exclusive: info?.exclusive ?? null,
      };
    }
    const json = JSON.stringify(payload);
    if (json === this.#prepareSent) return;
    this.#prepareSent = json;
    this.ctx.publish(customEvent(SONG_PREPARE_TOPIC, payload as unknown as JsonValue));
  }

  async #resubmit(entry: SongEntry, signal?: AbortSignal): Promise<void> {
    const job = await this.worker.submit(
      this.#query(entry.query, entry.key, entry.backing),
      signal,
    );
    entry.job = job.id;
    this.#apply(entry, job);
  }

  async run(signal: AbortSignal): Promise<void> {
    let last = 0;
    while (!signal.aborted) {
      const now = this.ctx.clock.now();
      if (now - last >= this.cfg.poll_ms) {
        last = now;
        await this.poll(signal);
        this.tick();
        await this.save();
      }
      await sleep(Math.min(this.cfg.poll_ms, 500), signal);
    }
  }

  // ----- the stored set list -----

  /**
   * Reads the set list Core had before it stopped (module start). Preparing songs re-attach to
   * their worker jobs on the next poll; ready ones are offered or sung as usual.
   */
  async restore(): Promise<void> {
    const store = this.ctx.services.get(SettingsStoreKey);
    if (!store || this.cfg.only_on_request) return;
    try {
      const raw = await store.get(STORE_PROFILE, SETLIST_KEY);
      if (raw === null) return;
      const n = this.list.restore(raw);
      // A song cut off with nothing to sing is over: its charges go back.
      for (const e of this.list.all()) if (e.state === "failed") this.#release(e);
      this.#saved = JSON.stringify(this.list.snapshot());
      for (const e of this.list.preparing()) if (e.job === null) this.#orphans.add(e.no);
      if (n > 0) {
        log.info(
          { songs: n, open: this.list.open().length, preparing: this.list.preparing().length },
          "restored the set list",
        );
      }
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read the stored set list");
    }
  }

  /** Writes the set list when it changed since the last write. */
  async save(): Promise<void> {
    const store = this.ctx.services.get(SettingsStoreKey);
    if (!store || this.cfg.only_on_request) return;
    const snapshot = this.list.snapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.#saved) return;
    try {
      await store.set(STORE_PROFILE, SETLIST_KEY, snapshot);
      this.#saved = json;
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot store the set list");
    }
  }

  close(): void {
    this.#closed = true;
    this.#playing?.stop.abort();
    this.#updatePause();
    this.#publishPrepare();
  }

  // ----- talking to her -----

  /**
   * An announcement (a song starting, done or failed, her voice about to go away): an impulse
   * of source `song` for the Arbiter, never her own topic (it does not count toward what she
   * raised on her own, nor its backoff).
   */
  #tell(where: ContextKey, reason: string, hint: string, entry: SongEntry): void {
    const about: AccountRef[] = entry.requester ? [entry.requester] : [];
    const impulse = newImpulse(
      {
        source: "song",
        context: where,
        account: entry.requester,
        // A song about to start, or her voice about to go away, needs her words now or never.
        ttlMs:
          reason === REASONS.start || reason === REASONS.prepare
            ? EXPECT_OPENING_MS
            : ANNOUNCE_TTL_MS,
        why: `${songLabel(entry)}(${reason})`,
        hint,
        about,
        reason,
        coalesce_key: `song:${entry.no}:${reason}`,
      },
      this.ctx.clock.now(),
    );
    this.ctx.publish(v2Event(ARBITER_IMPULSE_TOPIC, impulse));
  }

  /**
   * The lyrics card of a song about to play (`[modules.sing] lyrics_card`), or `null`: none for a
   * song without synced lyrics; it goes where she last typed in that server, else her voice
   * channel's text chat.
   */
  #lyricsCard(song: SongMeta, guild: string): LyricsCard | null {
    if (!this.cfg.lyrics_card) return null;
    if (!song.lyrics?.synced || song.lyrics.lines.length === 0) return null;
    const voice = this.voiceContext(guild);
    if (voice === null) return null;
    const context = this.#lastTyped.get(`${voice.platform}:${guild}`) ?? voice;
    const sink = this.ctx.services.get(PlatformSinksKey)?.get(context.platform);
    if (!sink?.edit) return null;
    return new LyricsCard({ sink, context, song, clock: this.ctx.clock, log });
  }

  #cue(cue: SongCue): void {
    this.ctx.publish(customEvent(SONG_TOPIC, cue as unknown as JsonValue));
  }
}

const NOT_PREPARING: SongPrepare = { no: null, title: "", stage: "", progress: 0, exclusive: null };

function pct(p: number): string {
  return `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
}

function accountOf(v: JsonValue | undefined): AccountRef | null {
  if (!isJsonObject(v ?? null)) return null;
  const o = v as Record<string, JsonValue>;
  return typeof o.platform === "string" && typeof o.id === "string"
    ? { platform: o.platform, id: o.id }
    : null;
}

function contextOf(v: JsonValue | undefined): ContextKey | null {
  if (!isJsonObject(v ?? null)) return null;
  const o = v as Record<string, JsonValue>;
  const kind = o.kind;
  if (
    typeof o.platform !== "string" ||
    typeof o.channel !== "string" ||
    (kind !== "channel" && kind !== "thread" && kind !== "dm" && kind !== "voice")
  ) {
    return null;
  }
  return {
    platform: o.platform,
    scope: typeof o.scope === "string" ? o.scope : null,
    channel: o.channel,
    kind,
  };
}
