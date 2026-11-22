// The singing flow (docs/design/autonomy.md §22):
//
//   request ── worker job ──► preparing ──► ready ──► (she decides / forced) ──► playing ──► done
//
// * A request (her `sing_request` tool, `/queue song request`, a called `[modules.queue]` item
//   of kind `song`) adds a set list entry and submits a worker job; she keeps talking meanwhile.
// * Ready: songs asked for by command or the queue are sung as soon as she is in voice and free
//   (forced). For the others she is told (an impulse of source `song`, `song_ready`, which the
//   Arbiter admits and her runner wakes her with): she picks the moment with `sing.play` and an
//   opening line, or not; she is told again a couple of times, and her turns see the set list
//   (prompt section `sing`). Without the Arbiter and her runner, ready songs start on their own.
// * Before a song starts she finishes what she is saying (the turn that started it, then a quiet
//   moment). While it plays the module holds her voice channel (`VoiceFloorKey`: her speech there
//   is dropped instead of queueing behind the song), barge-in does not apply (it is not her
//   speech), and only `sing.stop` (skip / stop) ends it early.
// * After a song that played to the end she is told, so she can say something about it.
// * When the worker takes the whole GPU to convert (its TTS / ASR go away for a minute or two),
//   she first says she is off to prepare it, and only then does the worker go ahead
//   (`exclusive: "waiting"` → `goExclusive`). Meanwhile speech is paused (`SpeechPauseKey`,
//   `Events.SpeechPause`): the voice module neither speaks nor transcribes, the overlay says so.
// * The song being prepared, its worker stage and progress are published as
//   `Events.SingPrepare` whenever they change (the overlay's activity line).
// * Once the worker has made a song, its audio is brought onto Core (`SongAudio`, stage `fetch`)
//   before the song counts as ready, so she never sits "singing" while it comes over the network.
//   A fetch that fails is tried again; the worker no longer having the song makes it again (the
//   failover sends that to the next worker when the first is gone). A song whose audio went from
//   Core (the budget, a restart without it) goes back to `fetch` when it is about to be sung, and
//   keeps its place. She is shown as singing (`singing()`, the card) only once the playback started.
// * A request with a song priority ticket (`priority`, the person's own command or member page
//   only) pays it first through `SongPriorityKey` and stands ahead of the songs without one. A
//   song that is not sung (it could not be listed or made, it failed, it was cancelled, or it was
//   stopped before the voice node played any of it, which ends it as cancelled) gives the
//   ticket back; a refund that did not go (the wallet was not there) keeps the ticket's key on the
//   entry and is tried again every `REFUND_RETRY_MS` (the ledger gives a charge back once, so a
//   retry never pays twice). Once the song starts being sung (or ends counted as sung) the ticket
//   is used (`SongPriority.consume`), and never given back. The market keeps every charge in its
//   own table and gives back one that is neither used nor held by the set list (`holdsTicket`,
//   `SongTicketsKey`) after a grace period, so a charge lost half way (before the set list was
//   saved, a refund that failed before the song was listed, a song trimmed from the history with
//   its refund due) still goes back. Her prompt says nothing of it: the order is the whole effect.

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { CapabilityError } from "@miyoria/gate/actions";
import { type RequestQueue, RequestQueueKey } from "@miyoria/play/queue";
import { errorMessage, getLogger, type ModuleContext } from "@miyoria/runtime/kernel";
import { PeopleStoreKey, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type ArbiterDecision,
  ArbiterKey,
  type BusEvent,
  type ContextKey,
  contextKeyEquals,
  Events,
  ImpulseHostKey,
  is,
  isJsonObject,
  type JsonValue,
  newImpulse,
  type PersonId,
  PlacesKey,
  type PlaybackState,
  type SetlistLine,
  type SongCue,
  type SongPrepare,
  SongPriorityKey,
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
  WorldStateKey,
} from "@miyoria/types";
import { MemorySongAudio, type SongAudio, SongAudioMissingError } from "./audio.js";
import {
  type GpuContext,
  type SingWorker,
  SingWorkerError,
  type SongMeta,
  type SongQuery,
  type WorkerJob,
} from "./client.js";
import type { SingConfig } from "./config.js";
import { findKept } from "./library.js";
import type { LocalVideoFetcher } from "./local-video.js";
import { ensureVideo, singSong, sleep, songVideoPath } from "./player.js";
import {
  type BackingMode,
  type NewSong,
  SetList,
  type SongEntry,
  type SongNo,
  songGuild,
  songLabel,
} from "./setlist.js";
import { parseSongPatch, songNo } from "./steer.js";

const log = getLogger("sing");

const TICK_MS = 100;
/** How often `keepLibrary` asks whether a song worker answers. */
const LIBRARY_EVERY_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5000;
/** How often the songs a worker made are brought onto Core while it answers. */
const MIRROR_EVERY_MS = 10 * 60_000;
/** Settings key (profile `_global`) of the stored set list. */
export const SETLIST_KEY = "sing:setlist";
const STORE_PROFILE = "_global";
const TURNS_REMEMBERED = 64;
/** Announcement impulses followed (their decisions are kept until the song has started). */
const ANNOUNCEMENTS_REMEMBERED = 32;

/** An announcement no longer makes sense after this. */
const ANNOUNCE_TTL_MS = 2 * 60_000;
/** How often a song priority ticket whose refund did not go is tried again. */
export const REFUND_RETRY_MS = 30_000;

/** Initiative / mind suggestion reasons. */
export const REASONS = {
  ready: "song_ready",
  start: "song_start",
  done: "song_done",
  failed: "song_failed",
  prepare: "song_prepare",
} as const;

export class SingError extends CapabilityError {
  override readonly name: string = "SingError";
}

/** A song priority ticket could not be taken: nothing was charged, the song was not listed. */
export class SongPriorityError extends SingError {
  override readonly name = "SongPriorityError";
}

/** A request: what to look for, and who asked. */
export type SongRequest = NewSong;

const LINK = /https?:\/\/[^\s<>"'「」]+/i;
/** A link pasted without its scheme (`www.bilibili.com/video/BV…/`, `youtu.be/…`): one of the usual hosts. */
const BARE_LINK =
  /(?<![\w./-])(?:www\.[\w-]+\.[a-z]{2,}|(?:music\.)?youtube\.com|m\.youtube\.com|youtu\.be|bilibili\.com|b23\.tv)\/[^\s<>"'「」]*/i;

/**
 * The worker request for a set list query: a link (anywhere in it, e.g. 「唱這首 https://…」),
 * `library:<path>`, or a search.
 */
export function workerQuery(query: string, key: number, backing: BackingMode = "keep"): SongQuery {
  const q = query.trim();
  const bare = BARE_LINK.exec(q)?.[0];
  const link = LINK.exec(q)?.[0] ?? (bare === undefined ? undefined : `https://${bare}`);
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
  /** The voice node reports it playing: her voice is out. */
  started: boolean;
}

/** The stage of a song whose audio is being brought onto Core (`SONG_PREPARE_STAGES`). */
export const FETCH_STAGE = "fetch";
/** Tries at bringing a song's audio onto Core before it fails (a broken transfer resumes). */
export const FETCH_ATTEMPTS = 5;

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
  /** Her speech playbacks running per guild. */
  readonly #speaking = new Map<string, number>();
  /** Song clips of a party game playing per guild: not her singing, but nothing starts over them. */
  readonly #clips = new Map<string, number>();
  readonly #turnsDone: TurnId[] = [];
  /** What the Arbiter decided on each announcement impulse of a song start (`null`: not yet). */
  readonly #announced = new Map<string, ArbiterDecision | null>();
  #closed = false;
  /**
   * Whether someone is in her voice channel of `guild`: `true` / `false`, or `null` when that is
   * not known (no member list yet, or an account of another platform such as a web viewer).
   */
  #present: (guild: string, who: AccountRef) => boolean | null = () => null;
  /** JSON of the set list last stored. */
  #saved: string | null = null;
  /** Restored songs that never reached the worker. */
  readonly #orphans = new Set<SongNo>();
  /** When refunds that did not go were last tried again (epoch ms). */
  #refundsTried = 0;
  /** Ticket keys whose refund is under way: a retry round meanwhile leaves them alone. */
  readonly #refunding = new Set<string>();
  /** The stored set list was read back (or there was none): `holdsTicket` can tell. */
  #restored = false;
  /** Songs whose job has (or is about to have) the GPU, by number. */
  readonly #gpu = new Set<SongNo>();
  #preparing: Preparing | null = null;
  /** Jobs told to go ahead that may still report `waiting` for a poll. */
  readonly #told = new Set<string>();
  #lastNotice = Number.NEGATIVE_INFINITY;
  #paused = false;
  /** What the worker last said about preparing songs (not stored). */
  readonly #jobs = new Map<SongNo, { title: string; exclusive: string | null }>();
  /** JSON of the `Events.SingPrepare` payload last published. */
  #prepareSent = JSON.stringify(NOT_PREPARING);
  /** The song the overlay is shown, and the furthest its progress got: it stays until it ends. */
  #shown: { no: SongNo; progress: number } | null = null;
  /** Since when no poll of the worker got an answer (epoch ms), or `null`. */
  #lostSince: number | null = null;
  /** Songs whose audio is being brought onto Core, by number: which song, and its stop. */
  readonly #fetching = new Map<SongNo, { song: string; stop: AbortController }>();
  /** Videos this process brought onto Core, and the fetches running. */
  readonly #videos = new Set<string>();
  readonly #videoFetches = new Map<string, Promise<string | null>>();
  readonly #audio: SongAudio;
  /** The songs on Core that can be sung without a worker (`SongAudio.library`), newest first. */
  #kept: SongMeta[] = [];
  /** Whether a song worker answered the last health check (`keepLibrary`); `null`: not asked yet. */
  #workerUp: boolean | null = null;

  /**
   * `videoDir`: the worker's cache dir (absolute) when song videos are shown on stream
   * (`[modules.sing] video`), else `null`. `tellContext`: also gets who listens and which songs
   * are needed now, each time the worker is told (Core sends it on to the hosts' GPU arbiters).
   * `audio`: where the songs' audio is kept on Core (default in memory, from `worker.audio`).
   * `localVideo`: downloads a song's video on this machine before the worker is asked
   * (`video_source = "local"`), else `null`.
   */
  constructor(
    private readonly cfg: SingConfig,
    private readonly ctx: ModuleContext,
    private readonly worker: SingWorker,
    private readonly videoDir: string | null = null,
    private readonly tellContext: ((context: GpuContext) => void) | null = null,
    audio: SongAudio | null = null,
    private readonly localVideo: LocalVideoFetcher | null = null,
  ) {
    this.list = new SetList(cfg);
    this.#audio =
      audio ??
      new MemorySongAudio(
        worker,
        cfg.lip_sync_vocals ? ["play_mix.pcm", "play_vocals.pcm"] : ["play_mix.pcm"],
      );
  }

  /** Where she learns who is in voice (the module's `VoiceRoom`). */
  setPresence(present: (guild: string, who: AccountRef) => boolean | null): void {
    this.#present = present;
  }

  // ----- views -----

  /**
   * Whether a song that starts on its own waits for its requester: they left the voice channel
   * she is in (2026-11-12: a song asked for by command was sung to someone who had gone). It
   * stays ready and starts once they are back; songs whose people are there go first.
   */
  waitsForRequester(entry: SongEntry): boolean {
    if (entry.requester === null || entry.practice === true) return false;
    const where = this.#voiceFor(entry);
    if (where === null || where.scope === null) return false;
    return this.#present(where.scope, entry.requester) === false;
  }

  /** `SpeechPause`: speech is off while a song's job has the GPU. */
  paused(): string | null {
    return this.#paused ? "song" : null;
  }

  holder(guild: string): string | null {
    const p = this.#playing;
    return p?.audible && p.guild === guild ? "song" : null;
  }

  /** The song started (from her opening line on), or `null`. */
  playing(): SongEntry | null {
    return this.#playing?.entry ?? null;
  }

  /** The song whose audio is going out now (the voice node reports it playing), or `null`. */
  singing(): SongEntry | null {
    return this.#playing?.started ? this.#playing.entry : null;
  }

  /** The song's audio is being brought onto Core. */
  fetching(no: SongNo): boolean {
    return this.#fetching.has(no);
  }

  /**
   * `VoiceFloor`: songs still to sing in `guild`: asked for there, or outside a server for it (a
   * song of before there were several servers, with no server at all, counts everywhere).
   */
  pending(guild: string): number {
    return this.list.open().filter((e) => this.#isFor(e, guild)).length;
  }

  /** Whether `e` is sung in `guild`. */
  #isFor(e: SongEntry, guild: string): boolean {
    const own = songGuild(e);
    return own === null || own === guild;
  }

  /** Her voice channel where `e` is sung: its server's; any for a song with no server. */
  #voiceFor(e: SongEntry): ContextKey | null {
    const own = songGuild(e);
    return own === null ? this.voiceContext() : this.voiceContext(own);
  }

  /** `VoiceFloor`: the songs of `pending`, by the numbers she sings them with. */
  setlist(guild: string): SetlistLine[] {
    return this.list
      .open()
      .filter((e) => e.state !== "playing" && this.#isFor(e, guild))
      .map((e) => ({ no: e.no, label: songLabel(e), ready: e.state === "ready" }));
  }

  /** A song clip (`SingClips`) is playing in `guild` (+1) or ended (-1). */
  clipping(guild: string, delta: 1 | -1): void {
    const n = Math.max(0, (this.#clips.get(guild) ?? 0) + delta);
    if (n === 0) this.#clips.delete(guild);
    else this.#clips.set(guild, n);
  }

  /** Her speech or a clip is playing in `guild` right now. */
  noisy(guild: string): boolean {
    return (this.#speaking.get(guild) ?? 0) + (this.#clips.get(guild) ?? 0) > 0;
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
      // Somebody else wants the song she was only practising: it is theirs now.
      if (req.practice !== true) same.practice = false;
      return same;
    }
    if (req.practice === true && this.list.practicing().length >= this.cfg.max_practice) {
      throw new SingError(
        `already preparing ${this.cfg.max_practice} songs for yourself; sing one of them first`,
      );
    }
    // Asked for outside a server (a DM, the member page): it is sung in one server, the one it
    // names, else the requester's own (phase 6), never in whichever she happens to be in.
    const guild =
      req.context?.scope != null
        ? null
        : (req.guild ?? (await this.#homeGuild(req.requester).catch(() => null)));
    // A ticket is paid before the song is listed, and given back if it cannot be.
    const ticket =
      req.priority === true
        ? await this.#chargePriority(req, query, req.context?.scope ?? guild)
        : null;
    let entry: SongEntry;
    try {
      entry = this.list.add(
        { ...req, query, guild, priority: ticket !== null, priority_key: ticket },
        toTimestamp(this.ctx.clock.now()),
      );
    } catch (error) {
      if (ticket !== null && req.requester !== null) {
        await this.#refundPriority(req.requester, ticket);
      }
      throw new SingError(errorMessage(error), { cause: error });
    }
    // Known to be off: a kept song is sung at once, without waiting for a worker to time out.
    const known = this.#workerUp === false ? await this.#findKept(entry) : null;
    if (known !== null) {
      this.#singKept(entry, known);
      return entry;
    }
    try {
      const job = await this.worker.submit(this.#query(query, req.key, entry.backing), signal);
      entry.job = job.id;
      this.#apply(entry, job);
      this.#publishPrepare();
    } catch (error) {
      const off = error instanceof SingWorkerError && error.unreachable;
      const kept = off ? await this.#findKept(entry) : null;
      if (kept !== null) {
        this.#singKept(entry, kept);
        return entry;
      }
      // The caller hears about it from the error; no separate notice.
      this.#fail(entry, errorMessage(error), false);
      if (off) {
        throw new SingError(
          `歌曲工作站現在沒開,做不了新歌;現在只能唱已經做好的歌(${errorMessage(error)})`,
          { cause: error },
        );
      }
      throw new SingError(`could not ask the song worker: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    return entry;
  }

  // ----- songs kept on Core -----

  /** The songs she can sing while no song worker answers; `null` while one does (or not known). */
  offlineSongs(): readonly SongMeta[] | null {
    return this.#workerUp === false ? this.#kept : null;
  }

  /**
   * The kept song an entry asks for, in the key and backing it was made in (a request for another
   * key or backing needs a worker). Reads the library when none was read yet.
   */
  async #findKept(entry: SongEntry): Promise<SongMeta | null> {
    if (entry.key !== 0 || (entry.backing ?? "keep") !== "keep") return null;
    if (this.#kept.length === 0 && this.#audio.library) {
      this.#kept = await this.#audio.library().catch(() => []);
    }
    return findKept(entry.query, this.#kept);
  }

  /** Sings a kept song: its audio is on Core already, no worker is asked. */
  #singKept(entry: SongEntry, song: SongMeta): void {
    log.info(
      { no: entry.no, song: song.id },
      "no song worker answers; singing a song kept on Core",
    );
    entry.song = song;
    entry.stage = "done";
    if (this.#audio.ready(song)) this.#ready(entry, false);
    else this.#fetchAudio(entry, false);
    this.#publishPrepare();
  }

  /**
   * Keeps the songs on Core up to date (module task): every `LIBRARY_EVERY_MS` asks whether a
   * song worker answers; while one does, brings what it has made onto Core (within the budget)
   * when it came back and every `MIRROR_EVERY_MS`, so the songs can be sung when it is off.
   */
  async keepLibrary(signal: AbortSignal): Promise<void> {
    let mirrored = Number.NEGATIVE_INFINITY;
    while (!signal.aborted) {
      const why = await this.worker
        .health(AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]))
        .catch((error: unknown) => errorMessage(error));
      if (signal.aborted) return;
      const up = why === null;
      if (up !== this.#workerUp) {
        if (up) log.info("a song worker answers");
        else log.info({ why }, "no song worker answers; only the songs kept on Core can be sung");
        if (up) mirrored = Number.NEGATIVE_INFINITY;
      }
      this.#workerUp = up;
      const now = this.ctx.clock.now();
      if (up && this.#audio.mirror && now - mirrored >= MIRROR_EVERY_MS) {
        mirrored = now;
        try {
          const came = await this.#audio.mirror(await this.worker.songs(signal), signal);
          if (came > 0) log.info({ came }, "songs kept on Core for when no worker answers");
        } catch (error) {
          if (signal.aborted) return;
          log.debug({ err: errorMessage(error) }, "could not keep the worker's songs on Core");
        }
      }
      if (this.#audio.library) {
        this.#kept = await this.#audio.library().catch(() => this.#kept);
      }
      await sleep(LIBRARY_EVERY_MS, signal);
    }
  }

  /**
   * Takes one song priority ticket from the requester (`SongPriorityKey`, the market's): the key
   * it is charged under. Throws a `SongPriorityError` with the reason when it cannot.
   */
  async #chargePriority(req: SongRequest, query: string, guild: string | null): Promise<string> {
    const port = this.ctx.services.get(SongPriorityKey);
    if (req.requester === null) throw new SongPriorityError("點歌優先券要有點歌的人");
    if (!port || port.terms() === null) throw new SongPriorityError("現在沒有賣點歌優先券");
    const key = `song:${randomUUID()}`;
    // The ticket is used in the queue of the server the song is sung in.
    const space =
      guild === null
        ? null
        : (this.ctx.services.get(PlacesKey)?.ofGuild(req.requester.platform, guild)?.id ?? null);
    const charged = await port.charge(req.requester, key, `song:${safeName(query, 60)}`, space);
    if (!charged.ok) throw new SongPriorityError(charged.message);
    return key;
  }

  /**
   * The server a song asked for outside one is sung in, by the requester's own servers: the one
   * she is in voice in now, else the primary, else their first; `null` without identity's places
   * or for someone who is in none (the song is then sung in any).
   */
  async #homeGuild(requester: AccountRef | null): Promise<string | null> {
    const places = this.ctx.services.get(PlacesKey);
    if (places === undefined || requester === null) return null;
    const person = await this.ctx.services.get(PeopleStoreKey)?.personByAccount(requester);
    const mine = person ? places.spacesOf(person.id as PersonId) : [];
    const pick =
      mine.find((s) => this.voiceContext(s.external_id) !== null) ??
      mine.find((s) => s.primary) ??
      mine[0] ??
      places.primary();
    return pick?.external_id ?? null;
  }

  /**
   * Whether a song asked for now for `guild` would wait: she is in voice, but in another server
   * (it is sung the next time she is in voice there). `false` for no server or no voice at all.
   */
  waitsElsewhere(guild: string | null): boolean {
    return guild !== null && this.#voices.length > 0 && this.voiceContext(guild) === null;
  }

  async #refundPriority(requester: AccountRef, key: string): Promise<boolean> {
    try {
      const port = this.ctx.services.get(SongPriorityKey);
      if (!port) {
        log.warn({ key }, "no song priority ticket to refund through");
        return false;
      }
      await port.refund(requester, key);
      return true;
    } catch (error) {
      log.warn({ key, err: errorMessage(error) }, "cannot refund a song priority ticket");
      return false;
    }
  }

  /**
   * The songs that ended without being sung and still hold a ticket (a refund that did not go,
   * or a song restored as failed) give it back now; at most every `REFUND_RETRY_MS`.
   */
  async #retryRefunds(): Promise<void> {
    const now = this.ctx.clock.now();
    if (now - this.#refundsTried < REFUND_RETRY_MS) return;
    this.#refundsTried = now;
    for (const e of this.list.all()) {
      if ((e.state === "failed" || e.state === "cancelled") && e.priority_key) {
        await this.#giveBackPriority(e);
      }
      if (e.state === "done" && e.priority_key) this.#consumePriority(e);
    }
  }

  /** A song that ended without being sung (failed, cancelled) gives its ticket back, once. */
  async #giveBackPriority(entry: SongEntry): Promise<void> {
    const key = entry.priority_key ?? null;
    if (key === null || entry.requester === null || this.#refunding.has(key)) return;
    this.#refunding.add(key);
    try {
      if (await this.#refundPriority(entry.requester, key)) entry.priority_key = null;
    } finally {
      this.#refunding.delete(key);
    }
  }

  /**
   * The song started being sung (or counts as sung): its ticket is used, and the market keeps
   * that (`SongPriority.consume`). The key goes once it is kept; until then the retry round tries
   * again, and the market's pass sees the song held (`holdsTicket`), so it gives nothing back.
   */
  #consumePriority(entry: SongEntry): void {
    const key = entry.priority_key ?? null;
    if (key === null) return;
    const port = this.ctx.services.get(SongPriorityKey);
    if (!port) return;
    try {
      port.consume(key);
      entry.priority_key = null;
    } catch (error) {
      log.warn({ key, err: errorMessage(error) }, "cannot mark a song priority ticket used");
    }
  }

  /**
   * Whether the set list holds the song a ticket was charged under (`SongTicketsKey`, for the
   * market's pass): listed, and not ended without being sung. `null` until the stored set list
   * was read back at start, when a song of before the stop would look gone.
   */
  holdsTicket(key: string): boolean | null {
    if (!this.#restored) return null;
    const entry = this.list.all().find((e) => e.priority_key === key);
    return entry !== undefined && entry.state !== "failed" && entry.state !== "cancelled";
  }

  #query(query: string, key: number, backing: BackingMode = "keep"): SongQuery {
    return { ...workerQuery(query, key, backing), exclusive_ack: this.cfg.prepare_notice };
  }

  /** Worker job state → entry. */
  #apply(entry: SongEntry, job: WorkerJob): void {
    if (entry.state !== "preparing") return;
    // The worker is done with it; its audio is on the way to Core.
    if (this.#fetching.has(entry.no)) return;
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
        if (this.#audio.ready(job.song)) this.#ready(entry, false);
        else this.#fetchAudio(entry, false);
        return;
      case "failed":
      case "cancelled":
        this.#fail(entry, job.error ?? job.state);
        return;
      default:
        return;
    }
  }

  /**
   * The song is ready: its audio is on Core. `again`: it was ready before and its audio had to be
   * fetched once more (it keeps its place and reminders; one that starts on its own starts).
   */
  #ready(entry: SongEntry, again: boolean): void {
    entry.state = "ready";
    entry.progress = 1;
    if (entry.stage === FETCH_STAGE) entry.stage = "done";
    // The video comes after the audio, while she gets to the song: it is shown when it is here.
    if (entry.song !== null && this.cfg.video) void this.#fetchVideo(entry.song);
    if (again && entry.ready_at !== null) {
      log.info({ no: entry.no, song: entry.song?.id }, "song ready again");
      if (!this.#closed) this.#autoStart();
      return;
    }
    entry.ready_at = toTimestamp(this.ctx.clock.now());
    log.info({ no: entry.no, song: entry.song?.id }, "song ready");
    this.#onReady(entry);
  }

  /**
   * Brings the song's audio onto Core (stage `fetch`); the song is ready once it is here. Tried
   * `FETCH_ATTEMPTS` times, `fallback_retry_secs` apart (a broken transfer resumes); the worker no
   * longer having the song makes it again; anything else fails the song.
   */
  #fetchAudio(entry: SongEntry, again: boolean): void {
    const song = entry.song;
    if (song === null || this.#closed) return;
    entry.state = "preparing";
    entry.stage = FETCH_STAGE;
    if (this.#fetching.get(entry.no)?.song === song.id) return;
    this.#fetching.get(entry.no)?.stop.abort();
    const stop = new AbortController();
    this.#fetching.set(entry.no, { song: song.id, stop });
    this.#publishPrepare();
    void (async () => {
      let failure: unknown = null;
      for (let attempt = 1; attempt <= FETCH_ATTEMPTS && !stop.signal.aborted; attempt++) {
        try {
          await this.#audio.fetch(song, stop.signal);
          failure = null;
          break;
        } catch (error) {
          failure = error;
          if (stop.signal.aborted || isGone(error)) break;
          log.warn(
            { no: entry.no, song: song.id, attempt, err: errorMessage(error) },
            "could not bring the song's audio onto Core",
          );
          if (attempt < FETCH_ATTEMPTS) {
            await sleep(this.cfg.fallback_retry_secs * 1000, stop.signal);
          }
        }
      }
      if (this.#fetching.get(entry.no)?.stop === stop) this.#fetching.delete(entry.no);
      // The song moved on meanwhile: cancelled, made again in another key, the module stopped.
      if (stop.signal.aborted || entry.state !== "preparing" || entry.song?.id !== song.id) return;
      if (failure === null) this.#ready(entry, again);
      else if (isGone(failure)) await this.#makeAgain(entry);
      else this.#fail(entry, `音檔傳不過來(${errorMessage(failure)})`);
      this.#publishPrepare();
    })().catch((error: unknown) => {
      log.warn({ no: entry.no, err: errorMessage(error) }, "the song's audio fetch broke");
    });
  }

  /** Stops bringing the song's audio onto Core (the song is over or changed). */
  #dropFetch(no: SongNo): void {
    this.#fetching.get(no)?.stop.abort();
    this.#fetching.delete(no);
  }

  /** The worker no longer has a song it made: the same request again, the song keeps its place. */
  async #makeAgain(entry: SongEntry): Promise<void> {
    let job: WorkerJob;
    try {
      job = await this.worker.submit(this.#query(entry.query, entry.key, entry.backing));
    } catch (error) {
      this.#fail(entry, `歌曲工作站沒有這首了,也無法重做(${errorMessage(error)})`);
      return;
    }
    if (entry.state !== "preparing") {
      void this.worker.cancel(job.id).catch(() => undefined);
      return;
    }
    log.info(
      { no: entry.no, job: job.id },
      "the song worker no longer has the song; making it again",
    );
    Object.assign(entry, {
      stage: "queued",
      progress: 0,
      error: null,
      song: null,
      job: job.id,
    } satisfies Partial<SongEntry>);
    this.#apply(entry, job);
    this.#updatePause();
  }

  /**
   * The song's video to show now: on Core already (fetched by this process, or on disk), else
   * `null`, and it is fetched for the next time. Singing never waits for a video.
   */
  async #videoNow(song: SongMeta): Promise<string | null> {
    if (this.videoDir === null) return null;
    const path = songVideoPath(this.videoDir, song);
    if (path === null) return null;
    if (this.#videos.has(song.id)) return path;
    try {
      await access(path);
      this.#videos.add(song.id);
      return path;
    } catch {
      void this.#fetchVideo(song);
      return null;
    }
  }

  /** Brings the song's video onto Core, once at a time; never throws. */
  #fetchVideo(song: SongMeta): Promise<string | null> {
    if (this.videoDir === null || songVideoPath(this.videoDir, song) === null) {
      return Promise.resolve(null);
    }
    const running = this.#videoFetches.get(song.id);
    if (running !== undefined) return running;
    const work = ensureVideo(
      this.worker,
      this.videoDir,
      song,
      new AbortController().signal,
      this.localVideo,
    )
      .then((path) => {
        if (path !== null) this.#videos.add(song.id);
        return path;
      })
      .finally(() => this.#videoFetches.delete(song.id));
    this.#videoFetches.set(song.id, work);
    return work;
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
    this.ctx.publish(Events.SpeechPause, { paused, reason: paused ? "song" : null });
  }

  #fail(entry: SongEntry, why: string, tell = true): void {
    if (entry.state !== "preparing" && entry.state !== "ready") return;
    this.#dropFetch(entry.no);
    log.info({ no: entry.no, why }, "song failed");
    this.list.finish(entry, "failed", why);
    this.#finishQueueItem(entry, false);
    void this.#giveBackPriority(entry);
    const where = entry.context ?? this.#voiceFor(entry);
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

  /** She can be told and decide: the Arbiter admits her impulses and her runner wakes her. */
  #sheDecides(): boolean {
    const s = this.ctx.services;
    return s.get(ArbiterKey) !== undefined && s.get(ImpulseHostKey) !== undefined;
  }

  #mindDecides(entry: SongEntry): boolean {
    // A song she prepared for herself is hers to sing or not: it never starts on its own.
    if (entry.practice === true) return this.#sheDecides();
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
    return this.#sheDecides();
  }

  #onReady(entry: SongEntry): void {
    if (!this.#mindDecides(entry)) {
      this.#autoStart();
      return;
    }
    this.#remind(entry);
  }

  /**
   * Whether her mind is reminded of `e` once more: the first notice plus `max_reminders` (while
   * she plays, until it starts). A song she practised gets the first notice only.
   */
  #remindsMore(e: SongEntry, gaming: boolean): boolean {
    if (e.practice === true) return e.reminders < 1;
    return gaming || e.reminders <= this.cfg.max_reminders;
  }

  /** Tells her the song is ready (again): an impulse she is woken with, and decides on. */
  #remind(entry: SongEntry): void {
    const where = this.#voiceFor(entry) ?? entry.context;
    entry.reminders += 1;
    entry.last_reminder_ms = this.ctx.clock.now();
    const voice = this.#voiceFor(entry) === null ? "你現在不在語音頻道,要唱得先進語音。" : "";
    const game = this.#game();
    const busy =
      game === null
        ? ""
        : `你正在玩 ${game}:想先唱就唱(唱完再回去玩),想先玩完就跟${entry.requester_name}說一聲等一下。`;
    const hint =
      entry.practice === true
        ? `你自己練的${songLabel(entry)}準備好了(#${entry.no}),還沒唱給誰聽。` +
          `有人在語音、你想唱的時候用 sing.play(song = ${entry.no}),opening 寫一句開場;不用急,之後也可以跟大家提一下新歌。${voice}${busy}`
        : `${entry.requester_name} 點的${songLabel(entry)}已經準備好了(#${entry.no})。` +
          `想唱就用 sing.play(song = ${entry.no}),opening 寫一句開場;現在不想唱也可以晚點再唱。${voice}${busy}`;
    if (where === null || !this.#sheDecides()) {
      this.#autoStart();
      return;
    }
    this.#tell(where, REASONS.ready, hint, entry);
  }

  /**
   * Starts the next song that should start on its own, when she is in voice and free. A song
   * whose requester left the channel is passed over until they are back (`waitsForRequester`).
   */
  #autoStart(): void {
    if (this.#playing || this.#closed) return;
    // A song of another server waits until she is in voice there (phase 6).
    const next = this.list
      .ready()
      .find(
        (e) =>
          e.practice !== true &&
          !this.#mindDecides(e) &&
          !this.waitsForRequester(e) &&
          this.#voiceFor(e)?.scope != null,
      );
    if (!next) return;
    const where = this.#voiceFor(next);
    if (where === null || where.scope === null) return;
    const announcement = this.#tell(
      where,
      REASONS.start,
      `你要開始唱${songLabel(next)}了(${next.requester_name} 點的)。用一句話開場,說完就開始。`,
      next,
    );
    this.#begin(next, where.scope, null, this.cfg.opening_window_ms, announcement);
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
      const more = this.#remindsMore(e, gaming);
      if (more && now >= due && this.#voiceFor(e) !== null) this.#remind(e);
    }
    this.#autoStart();
  }

  /**
   * Sings `no` (or the first ready song) in the voice channel of `context`'s guild. Returns the
   * entry once it is scheduled: it starts after `turn` (the turn asking for it) and a quiet moment.
   */
  play(no: SongNo | null, context: ContextKey | null, turn: TurnId | null): SongEntry {
    if (this.#playing) throw new SingError(`already singing ${songLabel(this.#playing.entry)}`);
    // Without a number: the first ready song of the server she would sing in.
    const here = context?.scope ?? this.voiceContext()?.scope ?? null;
    const ready = this.list.ready();
    const entry =
      no === null
        ? (ready.find((e) => here === null || this.#isFor(e, here)) ?? ready[0] ?? null)
        : this.list.get(no);
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
    if (!this.#isFor(entry, guild)) {
      throw new SingError(
        `song #${entry.no} was asked for in another server; it is sung when you are in voice there`,
      );
    }
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

  /**
   * Starts `entry` once her announcement is over. `announcement` is the id of the impulse that asks
   * her for it: the song waits for the Arbiter's word on it (the turn it opened, which it then
   * waits for, or a refusal or expiry), at most `expectMs`; nothing said after that is waited for.
   */
  #begin(
    entry: SongEntry,
    guild: string,
    turn: TurnId | null,
    expectMs: number,
    announcement: string | null = null,
  ): void {
    const stop = new AbortController();
    entry.state = "playing";
    this.#playing = { entry, guild, stop, audible: false, started: false };
    this.ctx.spawn(`song-${entry.no}`, async (signal) => {
      const both = AbortSignal.any([signal, stop.signal]);
      let outcome: PlaybackState | "error" = "interrupted";
      try {
        if (announcement === null) {
          await this.waitQuiet(guild, turn, expectMs, both);
        } else {
          const said = await this.#announcement(announcement, expectMs, both);
          await this.waitQuiet(guild, said.turn, 0, both);
        }
        if (!both.aborted) outcome = await this.#sing(entry, guild, both);
      } catch (error) {
        if (error instanceof SongAudioMissingError && !both.aborted) {
          this.#audioAgain(entry);
          return;
        }
        if (isGone(error) && !both.aborted && (await this.#prepareAgain(entry))) return;
        // Stopped while the audio was loading: a skip like any other, not a failure.
        if (!both.aborted) {
          log.warn({ no: entry.no, err: errorMessage(error) }, "could not sing");
          outcome = "error";
          entry.error = errorMessage(error);
        }
      }
      this.#ended(entry, guild, outcome);
    });
  }

  /**
   * The worker's cache cleaned the song out while it sat ready here (`workers/sing/cache.py`):
   * the same request again makes it again, and it is ready (and offered or started) as before.
   * Nothing was audible yet, so it keeps its place. `false`: the worker refused.
   */
  async #prepareAgain(entry: SongEntry): Promise<boolean> {
    let job: WorkerJob;
    try {
      job = await this.worker.submit(this.#query(entry.query, entry.key, entry.backing));
    } catch (error) {
      log.warn({ no: entry.no, err: errorMessage(error) }, "could not ask for a song again");
      return false;
    }
    log.info(
      { no: entry.no, job: job.id },
      "the song worker no longer has the song; making it again",
    );
    if (this.#playing?.entry === entry) this.#playing = null;
    if (entry.song) this.#cue({ state: "ended", song: entry.song.id, outcome: "interrupted" });
    Object.assign(entry, {
      state: "preparing",
      stage: "queued",
      progress: 0,
      error: null,
      song: null,
      ready_at: null,
      reminders: 0,
      last_reminder_ms: null,
      job: job.id,
    } satisfies Partial<SongEntry>);
    this.#apply(entry, job);
    this.#updatePause();
    this.#publishPrepare();
    if (!this.#closed) this.#autoStart();
    return true;
  }

  /**
   * The song was about to be sung but its audio is not on Core (any more): it goes back to
   * `fetch`, keeps its place, and is sung (or offered) again once the audio is here.
   */
  #audioAgain(entry: SongEntry): void {
    if (this.#playing?.entry === entry) this.#playing = null;
    log.info(
      { no: entry.no, song: entry.song?.id },
      "the song's audio is not on Core; fetching it",
    );
    this.#fetchAudio(entry, true);
    if (!this.#closed) this.#autoStart();
  }

  async #sing(entry: SongEntry, guild: string, signal: AbortSignal): Promise<PlaybackState> {
    const voice = this.ctx.services.get(VoicePlayerKey);
    if (!voice) throw new SingError("voice is not running");
    const song = entry.song;
    if (!song) throw new SingError("the song has no audio");
    if (!this.#audio.ready(song)) throw new SongAudioMissingError(`${song.id} is not on Core`);
    const video = this.cfg.video ? await this.#videoNow(song) : null;
    log.info({ no: entry.no, song: song.id, guild }, "singing");
    if (this.#playing?.entry === entry) this.#playing.audible = true;
    return singSong(
      {
        load: (track, s) => this.#audio.load(song, track, s),
        voice,
        clock: this.ctx.clock,
        cue: (cue) => {
          // Her voice is out: the song is being sung, and its ticket is used.
          if (cue.state === "started") {
            if (this.#playing?.entry === entry) this.#playing.started = true;
            this.#consumePriority(entry);
          }
          this.#cue(cue);
        },
        leadMs: this.cfg.lead_ms,
        fadeMs: this.cfg.fade_ms,
        lyrics: this.cfg.lyrics,
        lipSyncVocals: this.cfg.lip_sync_vocals,
        video,
      },
      song,
      guild,
      signal,
    );
  }

  #ended(entry: SongEntry, guild: string, outcome: PlaybackState | "error"): void {
    // Heard: the voice node reported the song itself playing. A stop before that (during her
    // opening, the quiet wait, or while the playback was set up) took nothing of it from anyone.
    const heard = this.#playing?.entry === entry && this.#playing.started;
    if (this.#playing?.entry === entry) this.#playing = null;
    if (entry.song) this.#cue({ state: "ended", song: entry.song.id, outcome });
    const finished = outcome === "finished";
    const unheard = outcome === "interrupted" && !heard;
    const sung = finished || (outcome === "interrupted" && heard);
    // A stopped song nobody heard is cancelled, not done: its ticket goes back (also on a later
    // round, should this refund not go), where a done song's is used.
    this.list.finish(entry, sung ? "done" : unheard ? "cancelled" : "failed", entry.error);
    this.#finishQueueItem(entry, finished);
    if (sung) this.#consumePriority(entry);
    else void this.#giveBackPriority(entry);
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
        if (e.job !== null && e.state === "preparing" && !this.#fetching.has(e.no)) {
          await this.worker.cancel(e.job).catch(() => undefined);
        }
        this.#dropFetch(e.no);
        this.list.finish(e, "cancelled");
        this.#finishQueueItem(e, false);
        await this.#giveBackPriority(e);
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
    if (entry.state === "preparing" && old !== null && !this.#fetching.has(entry.no)) {
      void this.worker.cancel(old).catch(() => undefined);
      this.#told.delete(old);
    }
    this.#dropFetch(entry.no);
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

  /**
   * Waits up to `windowMs` for the Arbiter's word on the announcement `id`: `turn` is the turn it
   * opened (she is saying it), `null` when it was refused or expired, or when nothing was decided
   * within the window (past it the impulse is expired and nothing is said).
   */
  async #announcement(
    id: string,
    windowMs: number,
    signal: AbortSignal,
  ): Promise<{ turn: TurnId | null }> {
    const clock = this.ctx.clock;
    const until = clock.now() + windowMs;
    try {
      for (;;) {
        const decision = this.#announced.get(id) ?? null;
        if (decision !== null) return { turn: decision.turn };
        if (signal.aborted || clock.now() >= until) return { turn: null };
        await sleep(TICK_MS, signal);
      }
    } finally {
      this.#announced.delete(id);
    }
  }

  /**
   * Resolves once the turn `turn` is over (when given) and her speech in `guild` had a quiet
   * moment: right after she spoke, or when she did not start within `expectMs`. `false` when
   * `signal` aborted or `announce_max_secs` ran out first.
   */
  async waitQuiet(
    guild: string,
    turn: TurnId | null,
    expectMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const clock = this.ctx.clock;
    const deadline = clock.now() + this.cfg.announce_max_secs * 1000;
    while (turn !== null && !this.#turnsDone.includes(turn) && clock.now() < deadline) {
      await sleep(TICK_MS, signal);
      if (signal.aborted) return false;
    }
    const t0 = clock.now();
    let spoke = false;
    let quietSince: number | null = null;
    while (clock.now() < deadline && !signal.aborted) {
      const now = clock.now();
      if (this.noisy(guild)) {
        spoke = true;
        quietSince = null;
      } else if (spoke || now - t0 >= expectMs) {
        quietSince ??= now;
        if (now - quietSince >= this.cfg.quiet_ms) return true;
      }
      await sleep(TICK_MS, signal);
    }
    return false;
  }

  // ----- events -----

  onEvent(event: BusEvent): void {
    if (is(Events.VoiceJoined, event)) {
      const c = event.data.context;
      this.#voices = [c, ...this.#voices.filter((v) => !contextKeyEquals(v, c))];
      // Now she can sing: ready songs of this server she decides about are brought up again.
      for (const e of this.list.ready()) {
        if (c.scope !== null && !this.#isFor(e, c.scope)) continue;
        if (this.#mindDecides(e) && this.#remindsMore(e, false)) this.#remind(e);
      }
      this.#autoStart();
      return;
    } else if (is(Events.VoiceLeft, event)) {
      const c = event.data.context;
      this.#voices = this.#voices.filter((v) => !contextKeyEquals(v, c));
      if (c.scope !== null) this.#speaking.delete(c.scope);
      return;
    } else if (is(Events.VoiceParticipants, event)) {
      // Someone came back: a song that waited for them may start now.
      this.#autoStart();
      return;
    } else if (is(Events.VoicePlaybackEvent, event)) {
      const guild = event.data.context.scope;
      if (guild === null) return;
      const n = this.#speaking.get(guild) ?? 0;
      if (event.data.state === "started") this.#speaking.set(guild, n + 1);
      else this.#speaking.set(guild, Math.max(0, n - 1));
      return;
    } else if (is(Events.ArbiterDecided, event)) {
      // A word on one of her song announcements: the turn it opened, or that nothing will be said.
      const d = event.data;
      if (d.verdict !== "deferred" && this.#announced.has(d.impulse))
        this.#announced.set(d.impulse, d);
      return;
    } else if (is(Events.AgentTurnCompleted, event)) {
      this.#turnsDone.push(event.data.turn);
      if (this.#turnsDone.length > TURNS_REMEMBERED) this.#turnsDone.shift();
      return;
    } else {
      if (is(Events.QueueItemActivated, event)) this.#onQueueItem(event.data as JsonValue);
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
    // The queue's item knows its server (a vote's winner has no context of its own).
    const space = this.ctx.services.get(RequestQueueKey)?.get(item)?.space ?? null;
    const guild =
      space === null ? null : (this.ctx.services.get(PlacesKey)?.space(space)?.external_id ?? null);
    void this.request({
      query: text,
      key: 0,
      requester,
      requester_name: name,
      context,
      ...(guild === null ? {} : { guild }),
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
    await this.#retryRefunds();
    if (this.list.preparing().length > 0) {
      // Without this the worker assumes people are listening, which is the careful answer.
      const context = this.#gpuContext();
      // The hosts whose hostd shares the card hear it too; a worker that asks its hostd ignores
      // the push, one that decides by itself (or runs where no hostd joined) still needs it.
      try {
        this.tellContext?.(context);
      } catch (e) {
        log.debug({ err: errorMessage(e) }, "could not tell the hosts who listens");
      }
      await this.worker
        .context(context, signal)
        .catch((e: unknown) => log.debug({ err: errorMessage(e) }, "could not update the worker"));
    }
    let answered = 0;
    let lost = 0;
    for (const entry of this.list.preparing()) {
      // Made already: its audio is on the way to Core.
      if (this.#fetching.has(entry.no)) continue;
      try {
        if (entry.job === null) {
          // Restored before the worker took it (a request in flight is not ours to repeat).
          if (this.#orphans.delete(entry.no)) await this.#resubmit(entry, signal);
          continue;
        }
        this.#apply(entry, await this.worker.job(entry.job, signal));
        answered += 1;
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof SingWorkerError && error.status === 404) {
          log.info({ no: entry.no, job: entry.job }, "the song worker lost the job; asking again");
          await this.#resubmit(entry, signal).catch((e: unknown) =>
            log.debug({ no: entry.no, err: errorMessage(e) }, "could not ask again"),
          );
          continue;
        }
        lost += 1;
        log.debug({ no: entry.no, err: errorMessage(error) }, "could not check a song job");
      }
    }
    if (answered > 0) this.#lostSince = null;
    else if (lost > 0) this.#lostSince ??= this.ctx.clock.now();
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

  /**
   * Publishes the song being prepared (`Events.SingPrepare`) when it changed. One song at a time:
   * the one shown stays until it is no longer preparing (it is not swapped for another that got
   * further, which made the overlay flip between two jobs); the next is the one furthest along,
   * the lowest number on a tie. Its progress never goes back, and a worker that has not answered
   * for `LOST_AFTER_MS` is reported as `unreachable` instead of freezing the bar.
   */
  #publishPrepare(): void {
    const preparing = this.#closed ? [] : this.list.preparing();
    for (const no of this.#jobs.keys()) {
      if (!preparing.some((e) => e.no === no)) this.#jobs.delete(no);
    }
    if (preparing.length === 0) this.#lostSince = null;
    let best: SongEntry | null = null;
    const idle = (e: SongEntry) => e.stage === "queued" || e.stage === "";
    const stuck =
      this.#shown === null ? undefined : preparing.find((e) => e.no === this.#shown?.no);
    // Only a song still waiting its turn gives way, and only to one the worker already runs.
    if (stuck !== undefined && !(idle(stuck) && preparing.some((e) => !idle(e)))) best = stuck;
    else {
      // A job the worker already runs goes before the queued ones.
      const rank = (e: SongEntry) => (idle(e) ? 0 : 1) + e.progress;
      for (const e of preparing) {
        if (best === null || rank(e) > rank(best) || (rank(e) === rank(best) && e.no < best.no)) {
          best = e;
        }
      }
      this.#shown = best === null ? null : { no: best.no, progress: 0 };
    }
    let payload: SongPrepare = NOT_PREPARING;
    if (best !== null && this.#shown !== null) {
      const info = this.#jobs.get(best.no);
      const query = best.query.trim();
      // A link or a library path is no title; the worker's comes once it found the song.
      const asked = LINK.test(query) || query.toLowerCase().startsWith("library:") ? "" : query;
      const progress = Math.min(Math.max(best.progress, this.#shown.progress, 0), 1);
      this.#shown.progress = progress;
      const lost =
        this.#lostSince !== null && this.ctx.clock.now() - this.#lostSince >= LOST_AFTER_MS;
      const by = best.practice === true ? "" : best.requester_name.trim();
      payload = {
        no: best.no,
        title: info?.title || asked,
        stage: lost ? "unreachable" : best.stage,
        progress: Math.round(progress * 1000) / 1000,
        exclusive: info?.exclusive ?? null,
        ...(by === "" ? {} : { by }),
      };
    }
    const json = JSON.stringify(payload);
    if (json === this.#prepareSent) return;
    this.#prepareSent = json;
    this.ctx.publish(Events.SingPrepare, payload);
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
    try {
      await this.#restore();
    } finally {
      this.#restored = true;
    }
  }

  async #restore(): Promise<void> {
    const store = this.ctx.services.get(SettingsStoreKey);
    if (!store) return;
    try {
      const raw = await store.get(STORE_PROFILE, SETLIST_KEY);
      if (raw === null) return;
      const n = this.list.restore(raw);
      this.#saved = JSON.stringify(this.list.snapshot());
      // A song of before there were several servers that was asked for outside one: the
      // original server's (it was the only one). Its place in the list and its state stay.
      const primary = this.ctx.services.get(PlacesKey)?.primary()?.external_id ?? null;
      if (primary !== null) {
        for (const e of this.list.open()) {
          if (songGuild(e) === null && e.practice !== true) e.guild = primary;
        }
      }
      for (const e of this.list.preparing()) {
        if (e.job !== null) continue;
        // A kept song (sung while no worker answered) has no job: its audio is on Core.
        if (e.song !== null) this.#fetchAudio(e, false);
        else this.#orphans.add(e.no);
      }
      // Ready means its audio is on Core: checked again (a disk cache finds it at once).
      for (const e of this.list.ready()) if (e.song !== null) this.#fetchAudio(e, true);
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
    if (!store) return;
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
    for (const no of [...this.#fetching.keys()]) this.#dropFetch(no);
    this.#updatePause();
    this.#publishPrepare();
  }

  // ----- talking to her -----

  /**
   * An announcement (a song starting, done or failed, her voice about to go away): an impulse
   * of source `song` for the Arbiter, never her own topic (it does not count toward what she
   * raised on her own, nor its backoff).
   */
  #tell(where: ContextKey, reason: string, hint: string, entry: SongEntry): string {
    const about: AccountRef[] = entry.requester ? [entry.requester] : [];
    const impulse = newImpulse(
      {
        source: "song",
        context: where,
        account: entry.requester,
        // A song about to start, or her voice about to go away, needs her words now or never.
        ttlMs:
          reason === REASONS.start || reason === REASONS.prepare
            ? this.cfg.opening_window_ms
            : ANNOUNCE_TTL_MS,
        why: `${songLabel(entry)}(${reason})`,
        hint,
        about,
        reason,
        coalesce_key: `song:${entry.no}:${reason}`,
      },
      this.ctx.clock.now(),
    );
    if (reason === REASONS.start) {
      this.#announced.set(impulse.id, null);
      while (this.#announced.size > ANNOUNCEMENTS_REMEMBERED) {
        const oldest = this.#announced.keys().next().value;
        if (oldest === undefined) break;
        this.#announced.delete(oldest);
      }
    }
    this.ctx.publish(Events.ArbiterImpulse, impulse);
    return impulse.id;
  }

  #cue(cue: SongCue): void {
    this.ctx.publish(Events.SingCue, cue);
  }
}

/** A worker that has not answered a poll for this long is shown as out of reach (ms). */
const LOST_AFTER_MS = 20_000;

const NOT_PREPARING: SongPrepare = { no: null, title: "", stage: "", progress: 0, exclusive: null };

/** The worker does not have the song's audio (any more): its cache cleaned it out. */
function isGone(error: unknown): boolean {
  return error instanceof SingWorkerError && error.status === 404;
}

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
