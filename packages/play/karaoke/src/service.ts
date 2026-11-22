// `KaraokeService`: single-player karaoke on the member page (docs/design/karaoke.md 「做了什麼
// (第一步)」). A member asks for a song by link or search; the song worker prepares it
// (`KaraokeWorkerKey`, the singing module's workers) and the pass follows the job; the backing
// track and the reference are fetched once onto Core and served to the member through signed
// links; at the end the browser sends its pitch track, Core scores it again with the shared
// module, stores the result and tells her once. Since step 3 (「做了什麼第三步」) the browser may
// also send one recording of the song: a song worker reads its pitch, Core scores that with the
// same module and it becomes the official result (`source: voice`); her note waits a bounded time
// for it. The recording only passes through memory here and is never written or logged. Since step
// 6 (「做了什麼第六步」) a panel admin may correct a song's reference (lyrics, guide notes, the whole
// curve's key): the edit is kept in the store as the song's override, which everything sung from
// then on is scored and shown against (`reference`); the worker's file on Core is never changed,
// and a restore drops the override. Scores already recorded stay as they were. Nothing here calls
// a model; nothing here moves coins.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  KaraokeAdminResults,
  KaraokeEditSave,
  KaraokeEditView,
  KaraokeOverview,
  KaraokeRequestResult,
  KaraokeResult,
  KaraokeSession,
  KaraokeSongView,
  KaraokeVoiceAccepted,
  KaraokeVoiceCheck,
  KaraokeVoiceState,
} from "@miyoria/contracts/api";
import {
  KARAOKE_FRAME_HZ,
  KARAOKE_MAX_SHIFT,
  KARAOKE_PLAY_RATE,
  KARAOKE_VIDEO_FILE,
  KARAOKE_VOICE_MAX_BYTES,
  karaokeBackingName,
  karaokePlayName,
  karaokeReferenceV2,
  shiftKaraokeReference,
  WorkersKaraokeReferenceSchema,
  type WorkersKaraokeReferenceV2,
  type WorkersKaraokeVoicePitch,
  type WorkersSingJob,
} from "@miyoria/contracts/workers";
import {
  type AccountRef,
  type ContextKey,
  type KaraokeFileName,
  type KaraokeWorker,
  newId,
  type PersonId,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import { commentContext, type KaraokeConfig, lyricsOptions } from "./config.js";
import {
  composeReference,
  EDIT_LIMITS,
  type EditDoc,
  editedLines,
  validateEdit,
} from "./edit/index.js";
import { resultNote } from "./notes.js";
import {
  alignSung,
  decodeTrack,
  encodeTrack,
  fromBase64,
  placeRecording,
  recordingInSong,
  type ScoreInput,
  type ScoreResult,
  scoreSinging,
  toBase64,
  voiceChecks,
} from "./score/index.js";
import { FileSigner, LINK_MS } from "./signing.js";
import type { KaraokeStore, ResultRow, SessionRow, SongRow, SongSung } from "./store.js";

const DAY_MS = 86_400_000;
/** How long a submitted track is kept (§13.2). */
export const TRACK_KEEP_MS = 7 * DAY_MS;
/** How long a song's files stay on Core after it was last sung (§13.3). */
export const FILES_KEEP_MS = DAY_MS;
/** How long her comment is waited for after she was told. */
export const COMMENT_WAIT_MS = 3 * 60_000;
/** Of the reference's voice the singer must have voiced for it to count as singing together. */
const TOGETHER_COVERAGE = 0.3;
/** Below this, she hears of it but is not asked to comment: hardly anything was sung. */
const COMMENT_COVERAGE = 0.15;
/** References kept parsed in memory. */
const KEEP_PARSED = 6;
/** A recording announced with the result must arrive within this, or the result stays 預估. */
export const VOICE_UPLOAD_MS = 3 * 60_000;
/** The longest a song worker may take to read a recording. */
export const VOICE_READ_MS = 150_000;
/** A recording may be this much longer than the song (the count-in, the ending). */
const VOICE_SLACK_S = 30;
/** How a recording may come. */
export const VOICE_TYPES = ["audio/webm", "audio/ogg", "audio/mp4"] as const;
/** The editor's own link to a song's backing track (the panel admin's session only). */
export const EDIT_BACKING_ROUTE = "/api/member/karaoke/edit";
/** Saves and restores the editor lists. */
const EDIT_HISTORY = 20;
/** Problems a refused save names (the rest are counted). */
const EDIT_PROBLEMS_SHOWN = 3;

/** What a signed link serves: a file on Core, or what is in memory (an edited reference). */
export type KaraokeServed =
  | { path: string; type: string }
  | { data: Uint8Array<ArrayBuffer>; type: string };

export const KARAOKE_FILES: readonly KaraokeFileName[] = ["reference.json", "karaoke.m4a"];

/** A file a signed link may name: the two, the video, or the backing in another key. */
function servable(name: string): name is KaraokeFileName {
  if ((KARAOKE_FILES as readonly string[]).includes(name) || name === KARAOKE_VIDEO_FILE) {
    return true;
  }
  const m = /^karaoke\.k([+-])([1-9]\d?)\.m4a$/.exec(name);
  return m !== null && Number(m[2]) <= KARAOKE_MAX_SHIFT;
}

/** A refusal: its HTTP status and a sentence for the member. */
export class KaraokeError extends Error {
  override readonly name = "KaraokeError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Who a member is to her: their person, or `null` for one she has none for. */
export interface KaraokeWho {
  person: PersonId | null;
  blocked: boolean;
}

/** One note she hears: the summary, its key, whom it is about, and where to say something. */
export interface KaraokeNote {
  summary: string;
  key: string;
  person: PersonId | null;
  /** The comment channel; `null`: she only hears of it (silent). */
  context: ContextKey | null;
}

export interface KaraokeDeps {
  config: KaraokeConfig;
  store: KaraokeStore;
  worker: () => KaraokeWorker | null;
  now: () => number;
  /** Absolute: where the songs' files are kept on Core. */
  cacheDir: string;
  who: (account: AccountRef) => KaraokeWho;
  tell: (note: KaraokeNote) => void;
  /** Singing with her: evidence for her nightly reflection on them. */
  together: (person: PersonId, detail: string, at: number, session: string) => void;
  log: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
  };
  signer?: FileSigner;
}

/** What the service asks the rooms about a room's session (`rooms.ts`). */
export interface RoomLink {
  /** The singer's live stream gives (or gave) the official score: no recording is wanted. */
  streams(session: string): boolean;
  /** The stream's final pitch, once it came: the official score, when the result is in. */
  finalOf(session: string): { pitch: WorkersKaraokeVoicePitch; offset_ms: number } | null;
  /** A room's session changed: its result came, or its official score, or it failed. */
  changed(session: string): void;
}

/** What the browser sends at the end of a song. */
export interface Submission {
  track: string;
  latency_ms: number;
  calibrated: boolean;
  client_total: number | null;
  browser: string;
  /** A recording of the song follows (`voice`); left out, none. */
  recording?: boolean;
}

/** The part of a song's preparation that is not kept: the worker's stage while it runs. */
interface Live {
  stage: string | null;
  progress: number;
  position: number | null;
}

/** How many looks may fail to bring a made song's files over before the song fails. */
const FETCH_TRIES = 8;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `url:<link>` or `query:<words>` of what a member typed, or `null` when it is neither. */
export function sourceOf(text: string): { key: string; url?: string; query?: string } | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (t === "") return null;
  if (/^https?:\/\//i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      return null;
    }
    url.hash = "";
    const link = url.toString();
    return { key: `url:${link}`, url: link };
  }
  if (t.length > 200) return null;
  return { key: `query:${t.toLowerCase()}`, query: t };
}

export class KaraokeService {
  readonly #d: KaraokeDeps;
  readonly #signer: FileSigner;
  readonly #live = new Map<string, Live>();
  /**
   * Parsed references as sung (the edit when there is one, else the worker's, in version 2's
   * shape), the most recently used last.
   */
  readonly #parsed = new Map<string, WorkersKaraokeReferenceV2>();
  /** Per song, how often its reference changed (a save, a restore): a read begun before is not kept. */
  readonly #changes = new Map<string, number>();
  /** Backings in another key being fetched, so two sessions do not fetch one twice. */
  readonly #keying = new Map<string, Promise<void>>();
  /** Songs whose files are being fetched, so two sessions do not fetch them twice. */
  readonly #fetching = new Map<string, Promise<void>>();
  /**
   * Songs the worker has made whose files did not all arrive, and how many looks failed: the next
   * look resumes them (a broken transfer keeps its part) instead of failing the song at once.
   */
  readonly #fetchTries = new Map<string, number>();
  /** Videos being fetched. */
  readonly #videos = new Map<string, Promise<boolean>>();
  /** Recordings being read by a worker and scored, by session. */
  readonly #voices = new Map<string, Promise<void>>();
  #rooms: RoomLink | null = null;

  constructor(deps: KaraokeDeps) {
    this.#d = deps;
    this.#signer = deps.signer ?? new FileSigner();
  }

  get config(): KaraokeConfig {
    return this.#d.config;
  }

  // ---- what a member sees ---------------------------------------------------------------------

  /** The start of her local day containing `now`. */
  #dayStart(now: number): number {
    const offset = this.#d.config.utc_offset_minutes * 60_000;
    return Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
  }

  #person(account: AccountRef): KaraokeWho {
    const who = this.#d.who(account);
    if (who.blocked) throw new KaraokeError(403, "現在不能唱");
    return who;
  }

  #view(
    song: SongRow,
    person: PersonId | null,
    bests?: Map<string, { best: number | null; sung: number }>,
  ): KaraokeSongView {
    const live = this.#live.get(song.id);
    const mine = bests?.get(song.id);
    return {
      id: song.id,
      title: song.title || song.source,
      artist: song.artist,
      duration_s: song.duration_ms === null ? null : Math.round(song.duration_ms / 100) / 10,
      state: song.status as KaraokeSongView["state"],
      stage: song.status === "preparing" ? (live?.stage ?? "queued") : null,
      progress:
        song.status === "ready" ? 1 : song.status === "preparing" ? (live?.progress ?? 0) : 0,
      position: song.status === "preparing" ? (live?.position ?? null) : null,
      error: song.status === "failed" ? song.error : null,
      lyrics: song.lyrics,
      lyrics_source:
        song.lyrics_source === "found" || song.lyrics_source === "heard"
          ? song.lyrics_source
          : null,
      notes: song.notes,
      video: song.video && this.#d.config.video,
      mine: person !== null && song.requested_by === person,
      best: mine?.best ?? null,
      sung: mine?.sung ?? 0,
    };
  }

  /**
   * Refused while karaoke is not open, unless `admin` (a panel admin may use everything while it
   * is closed, to try it before members can).
   */
  openFor(admin: boolean): void {
    if (!this.#d.config.open && !admin) throw new KaraokeError(409, "現在沒有開放唱 K");
  }

  overview(account: AccountRef, admin = false): KaraokeOverview {
    const { person } = this.#person(account);
    const now = this.#d.now();
    const store = this.#d.store;
    const bests = person === null ? new Map() : store.bestsOf(person);
    const ready = store.songsIn("ready", 300);
    const pending = person === null ? [] : store.pendingOf(person, now - DAY_MS);
    const cfg = this.#d.config;
    return {
      open: cfg.open,
      admin,
      preparing: this.#d.worker() !== null,
      songs: [...pending, ...ready].map((s) => this.#view(s, person, bests)),
      limits: {
        daily: cfg.daily_songs,
        used: person === null ? 0 : store.requestsSince(person, this.#dayStart(now)),
        max_minutes: Math.round((cfg.max_song_secs / 60) * 10) / 10,
      },
      tolerance_cents: cfg.tolerance_cents,
      comments: cfg.comment && commentContext(cfg.comment_channel) !== null,
      recent:
        person === null
          ? []
          : store.resultsOf(person, 10).map((r) => ({
              session: r.session_id,
              song: r.song_id,
              title: store.song(r.song_id)?.title ?? "",
              total: r.total,
              unranked: r.unranked,
              at: r.created_at,
            })),
    };
  }

  song(account: AccountRef, id: string): KaraokeSongView {
    const { person } = this.#person(account);
    const song = this.#d.store.song(id);
    if (song === null) throw new KaraokeError(404, "沒有這首歌");
    return this.#view(song, person, person === null ? undefined : this.#d.store.bestsOf(person));
  }

  /**
   * A song as anyone sees it, with its preparation and nobody's own best (a room's queue shows it
   * to everyone in the room); `null` when there is no such song.
   */
  songView(id: string): KaraokeSongView | null {
    const song = this.#d.store.song(id);
    return song === null ? null : this.#view(song, null);
  }

  /** A link or a search: the song already known, or a new preparation. */
  async request(account: AccountRef, text: string, admin = false): Promise<KaraokeRequestResult> {
    const { person } = this.#person(account);
    const cfg = this.#d.config;
    this.openFor(admin);
    const source = sourceOf(text);
    if (source === null) throw new KaraokeError(400, "請貼一個連結,或打歌名");
    const store = this.#d.store;
    const now = this.#d.now();
    // A song known by this link or search is that song; only a failed one is prepared again.
    const known = store.songBySource(source.key);
    if (known !== null && known.status !== "failed") {
      return { song: this.#view(known, person), created: false };
    }
    if (person === null) throw new KaraokeError(403, "她還不認識你,先在 Discord 跟她說說話");
    const used = store.requestsSince(person, this.#dayStart(now));
    if (used >= cfg.daily_songs) {
      throw new KaraokeError(
        409,
        cfg.daily_songs === 0
          ? "現在只能唱已經準備好的歌"
          : `今天已經準備了 ${used} 首(一天 ${cfg.daily_songs} 首),準備好的歌還是可以唱`,
      );
    }
    const worker = this.#d.worker();
    if (worker === null) throw new KaraokeError(503, "現在沒有能準備歌的機器");
    let job: WorkersSingJob;
    try {
      job = await worker.prepare({
        ...(source.url === undefined ? {} : { url: source.url }),
        ...(source.query === undefined ? {} : { query: source.query }),
        lyrics: lyricsOptions(cfg),
        video: cfg.video,
      });
    } catch (error) {
      this.#d.log.warn({ err: errorText(error) }, "karaoke: the worker did not take the song");
      const status = (error as { status?: unknown }).status;
      throw new KaraokeError(
        status === 400 ? 400 : 503,
        status === 400 ? "這個連結不能用,換一個或改打歌名" : "現在連不上準備歌的機器,等一下再試",
      );
    }
    const title = job.source?.title ?? "";
    let song: SongRow;
    if (known === null) {
      song = store.addSong(
        { id: newId(), source_key: source.key, source: text.trim(), title },
        person,
        now,
      );
    } else {
      store.retrySong(known.id, person);
      song = store.song(known.id) as SongRow;
    }
    store.patchSong(song.id, { job: job.id, ...(title ? { title } : {}) });
    store.addRequest(person, song.id, now);
    this.#follow(song.id, job);
    return { song: this.#view(store.song(song.id) as SongRow, person), created: true };
  }

  // ---- preparing ------------------------------------------------------------------------------

  /** One look at every song being prepared, and the upkeep when `upkeep`. */
  async tick(signal: AbortSignal, upkeep = false): Promise<void> {
    for (const song of this.#d.store.songsIn("preparing")) {
      if (signal.aborted) return;
      await this.#poll(song, signal);
    }
    this.#notesDue();
    if (upkeep) await this.#upkeep();
  }

  async #poll(song: SongRow, signal: AbortSignal): Promise<void> {
    const worker = this.#d.worker();
    if (worker === null || song.job === null) return;
    let job: WorkersSingJob;
    try {
      job = await worker.job(song.job, signal);
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) {
        this.#fail(song, "準備被中斷了,再點一次", errorText(error));
      }
      return;
    }
    this.#follow(song.id, job);
    if (job.state === "failed" || job.state === "cancelled") {
      this.#fail(
        song,
        failureText(job.error, this.#d.config.max_song_secs),
        job.error ?? job.state,
      );
      return;
    }
    if (job.state !== "done") return;
    const made = job.karaoke ?? null;
    if (made === null) {
      this.#fail(song, "準備失敗了,可以再點一次", "the job finished without a karaoke song");
      return;
    }
    if (made.quality !== null && !made.quality.ok) {
      this.#fail(song, "這首抓不到主旋律,換一首試試", made.quality.reason ?? "quality");
      return;
    }
    const duration = made.duration_s;
    if (duration !== null && duration > this.#d.config.max_song_secs) {
      this.#fail(song, tooLong(this.#d.config.max_song_secs), `${duration} s`);
      return;
    }
    // Prepared again (after a failure): what Core kept of the song before is the worker's old
    // version, so it is fetched anew (an edit of the song stays, in the store).
    // Not while its files are still on their way: those parts are what the next look resumes.
    if (song.worker_song !== null && !this.#fetchTries.has(song.id)) {
      this.#parsed.delete(song.id);
      await rm(this.#dir(song.id), { recursive: true, force: true }).catch(() => {});
    }
    this.#d.store.patchSong(song.id, { worker_song: made.id });
    try {
      await this.#fetch({ ...song, worker_song: made.id }, signal);
      this.#fetchTries.delete(song.id);
      const ref = await this.reference(song.id);
      this.#d.store.patchSong(song.id, {
        status: "ready",
        title: made.title || ref.title || song.title,
        artist: made.artist ?? ref.artist,
        duration_ms: Math.round(ref.duration_s * 1000),
        lyrics: ref.lyrics !== null && ref.lyrics.lines.length > 0,
        lyrics_source:
          ref.lyrics !== null && ref.lyrics.lines.length > 0 ? ref.lyrics.source : null,
        notes: ref.notes.length,
        video: made.video,
        ready_at: toTimestamp(this.#d.now()),
      });
      this.#live.delete(song.id);
      // The video is not needed to sing: fetched after, and a failure only means none is shown.
      if (made.video && this.#d.config.video) {
        void this.#fetchVideo({ ...song, worker_song: made.id });
      }
    } catch (error) {
      if (signal.aborted) return;
      // The link to the worker's machine drops long transfers now and then: the song stays in
      // preparation and the next look carries on from what arrived.
      const tries = (this.#fetchTries.get(song.id) ?? 0) + 1;
      if (tries < FETCH_TRIES) {
        this.#fetchTries.set(song.id, tries);
        this.#d.log.warn(
          { song: song.id, attempt: tries, err: errorText(error) },
          "karaoke: a song's files did not all arrive, trying again",
        );
        this.#live.set(song.id, { stage: "fetch", progress: 1, position: null });
        return;
      }
      this.#fetchTries.delete(song.id);
      this.#fail(song, "準備好了但拿不到檔案,再點一次", errorText(error));
    }
  }

  #follow(id: string, job: WorkersSingJob): void {
    this.#live.set(id, {
      stage: job.stage || null,
      progress: job.progress,
      position: job.position,
    });
  }

  #fail(song: SongRow, text: string, detail: string): void {
    this.#d.log.info({ song: song.id, detail }, "karaoke: a song could not be prepared");
    this.#d.store.patchSong(song.id, {
      status: "failed",
      error: text,
      error_detail: detail.slice(0, 500),
    });
    this.#live.delete(song.id);
  }

  #dir(song: string): string {
    return join(this.#d.cacheDir, song);
  }

  /** The song's files onto Core (from the worker that made them), unless they are there. */
  async #fetch(song: SongRow, signal?: AbortSignal): Promise<void> {
    const running = this.#fetching.get(song.id);
    if (running !== undefined) return running;
    const work = (async () => {
      const dir = this.#dir(song.id);
      const missing: KaraokeFileName[] = [];
      for (const name of KARAOKE_FILES) {
        if (!(await exists(join(dir, name)))) missing.push(name);
      }
      if (missing.length === 0) return;
      const worker = this.#d.worker();
      if (worker === null || song.worker_song === null) throw new Error("no worker has the song");
      await mkdir(dir, { recursive: true });
      const made = song.worker_song;
      for (const name of missing) await worker.file(made, name, join(dir, name), signal);
      // The worker's reference came again (the song prepared again, or its files cleared): a song
      // with an edit keeps it, and the editor learns whether the worker's changed under it.
      if (missing.includes("reference.json") && this.#d.store.override(song.id) !== null) {
        this.#sawWorker(song.id, hashOf(await readFile(join(dir, "reference.json"))));
      }
    })();
    this.#fetching.set(song.id, work);
    try {
      await work;
    } finally {
      this.#fetching.delete(song.id);
    }
  }

  /**
   * The song's background video onto Core, unless it is there: `true` once it is. Never throws (a
   * song without its video is sung over the still).
   */
  #fetchVideo(song: SongRow): Promise<boolean> {
    const running = this.#videos.get(song.id);
    if (running !== undefined) return running;
    const work = (async () => {
      const dest = join(this.#dir(song.id), KARAOKE_VIDEO_FILE);
      if (await exists(dest)) return true;
      const worker = this.#d.worker();
      if (worker === null || song.worker_song === null) return false;
      try {
        await mkdir(this.#dir(song.id), { recursive: true });
        await worker.file(song.worker_song, KARAOKE_VIDEO_FILE, dest);
        return true;
      } catch (error) {
        this.#d.log.info({ song: song.id, err: errorText(error) }, "karaoke: no video on Core");
        return false;
      }
    })();
    this.#videos.set(song.id, work);
    void work.finally(() => this.#videos.delete(song.id));
    return work;
  }

  /**
   * The song's reference as it is sung, parsed, in version 2's shape (kept for the next few): its
   * edit when a panel admin saved one, else the worker's. Every score, session, room round and the
   * stream's scene take it from here.
   */
  async reference(song: string): Promise<WorkersKaraokeReferenceV2> {
    const kept = this.#parsed.get(song);
    if (kept !== undefined) {
      this.#parsed.delete(song);
      this.#parsed.set(song, kept);
      return kept;
    }
    const row = this.#d.store.song(song);
    if (row === null) throw new KaraokeError(404, "沒有這首歌");
    const change = this.#changes.get(song) ?? 0;
    // The files are on Core either way: the backing is sung with the edit too.
    await this.#fetch(row);
    const override = this.#d.store.override(song);
    const raw =
      override?.reference ?? (await readFile(join(this.#dir(song), "reference.json"), "utf8"));
    const parsed = karaokeReferenceV2(WorkersKaraokeReferenceSchema.parse(JSON.parse(raw)));
    // A save or a restore while this was read: what was read is not kept.
    if ((this.#changes.get(song) ?? 0) !== change) return parsed;
    this.#parsed.set(song, parsed);
    while (this.#parsed.size > KEEP_PARSED) {
      const oldest = this.#parsed.keys().next().value as string;
      this.#parsed.delete(oldest);
    }
    return parsed;
  }

  /**
   * The worker's own reference of a song as it is on Core (fetched again when it is not), parsed,
   * and the SHA-256 of its bytes. With an edit, the hash is recorded as the latest worker's seen.
   */
  async workerReference(
    song: string,
  ): Promise<{ reference: WorkersKaraokeReferenceV2; hash: string }> {
    const row = this.#d.store.song(song);
    if (row === null) throw new KaraokeError(404, "沒有這首歌");
    await this.#fetch(row);
    const bytes = await readFile(join(this.#dir(song), "reference.json"));
    const hash = hashOf(bytes);
    if (this.#d.store.override(song) !== null) this.#sawWorker(song, hash);
    const reference = karaokeReferenceV2(
      WorkersKaraokeReferenceSchema.parse(JSON.parse(bytes.toString("utf8"))),
    );
    return { reference, hash };
  }

  /** The latest worker's reference of a song with an edit had this hash. */
  #sawWorker(song: string, hash: string): void {
    if (this.#d.store.override(song)?.worker_hash !== hash) {
      this.#d.store.setWorkerHash(song, hash);
    }
  }

  /** The song's reference changed (saved, restored): the parsed one is read again. */
  #changed(song: string): void {
    this.#changes.set(song, (this.#changes.get(song) ?? 0) + 1);
    this.#parsed.delete(song);
  }

  // ---- singing --------------------------------------------------------------------------------

  /** The backing `shift` semitones away onto Core: made by the worker that has the song, once. */
  async #fetchKey(song: SongRow, shift: number): Promise<void> {
    const name = karaokeBackingName(shift) as KaraokeFileName;
    const dest = join(this.#dir(song.id), name);
    if (await exists(dest)) return;
    const key = `${song.id}/${shift}`;
    const running = this.#keying.get(key);
    if (running !== undefined) return running;
    const work = (async () => {
      const worker = this.#d.worker();
      if (worker === null || song.worker_song === null) throw new Error("no worker has the song");
      const made = await worker.key(song.worker_song, shift);
      await worker.file(song.worker_song, made.file as KaraokeFileName, dest);
    })();
    this.#keying.set(key, work);
    try {
      await work;
    } finally {
      this.#keying.delete(key);
    }
  }

  /**
   * One singing of a ready song: a session and its signed links. `shift`: semitones to move the
   * key by (the worker renders the backing in that key; the reference moves with it).
   */
  async start(
    account: AccountRef,
    name: string,
    songId: string,
    shift = 0,
    admin = false,
  ): Promise<KaraokeSession> {
    this.#person(account);
    this.openFor(admin);
    const song = await this.readySong(songId, shift);
    return this.session(account, name, song, shift, null);
  }

  /**
   * A ready song with its files on Core, and its backing in the key `shift` away (made by the
   * worker that has the song, once): a refusal for people otherwise.
   */
  async readySong(songId: string, shift: number): Promise<SongRow> {
    if (!Number.isInteger(shift) || Math.abs(shift) > KARAOKE_MAX_SHIFT) {
      throw new KaraokeError(400, `升降調最多 ${KARAOKE_MAX_SHIFT} 個半音`);
    }
    const song = this.#d.store.song(songId);
    if (song === null) throw new KaraokeError(404, "沒有這首歌");
    if (song.status !== "ready") throw new KaraokeError(409, "這首還沒準備好");
    try {
      await this.#fetch(song);
      await this.reference(song.id);
    } catch (error) {
      if (error instanceof KaraokeError) throw error;
      this.#d.log.warn({ song: song.id, err: errorText(error) }, "karaoke: the files are gone");
      throw new KaraokeError(503, "這首的檔案現在拿不到,等一下再試");
    }
    if (shift !== 0) {
      try {
        await this.#fetchKey(song, shift);
      } catch (error) {
        this.#d.log.warn(
          { song: song.id, shift, err: errorText(error) },
          "karaoke: no backing in that key",
        );
        throw new KaraokeError(503, "現在做不出這個調,換回原調或等一下再試");
      }
    }
    return song;
  }

  /**
   * The files the stream's karaoke scene plays a round with (step 5), as paths on this machine
   * (the stage node runs on the streaming PC with Core and serves them to its overlay page): the
   * backing in the round's key as raw PCM when the worker can decode it (`karaokePlayName`, fetched
   * once and kept with the song), else the AAC file the members get; the background video when it
   * is on Core. Never throws: what is missing is `null`.
   */
  async streamFiles(
    song: SongRow,
    shift: number,
    signal?: AbortSignal,
  ): Promise<{
    backing: { path: string; format: "pcm" | "m4a"; rate: number } | null;
    video: string | null;
  }> {
    const dir = this.#dir(song.id);
    const video =
      song.video && this.#d.config.video && (await exists(join(dir, KARAOKE_VIDEO_FILE)))
        ? join(dir, KARAOKE_VIDEO_FILE)
        : null;
    const pcm = join(dir, karaokePlayName(shift));
    if (!(await exists(pcm))) {
      const worker = this.#d.worker();
      if (worker !== null && song.worker_song !== null) {
        try {
          await worker.file(
            song.worker_song,
            karaokePlayName(shift) as KaraokeFileName,
            pcm,
            signal,
          );
        } catch (error) {
          this.#d.log.info(
            { song: song.id, shift, err: errorText(error) },
            "karaoke: no PCM backing for the stream, the scene decodes the AAC one",
          );
        }
      }
    }
    if (await exists(pcm)) {
      return { backing: { path: pcm, format: "pcm", rate: KARAOKE_PLAY_RATE }, video };
    }
    const m4a = join(dir, karaokeBackingName(shift));
    return {
      backing: (await exists(m4a)) ? { path: m4a, format: "m4a", rate: KARAOKE_PLAY_RATE } : null,
      video,
    };
  }

  /**
   * One singing of a ready song (`readySong`) by `account`: a session and its signed links. `room`:
   * the room it is a round of (its result is the room's to tell her of), or `null` alone.
   */
  async session(
    account: AccountRef,
    name: string,
    song: SongRow,
    shift: number,
    room: string | null,
  ): Promise<KaraokeSession> {
    const { person } = this.#person(account);
    const now = this.#d.now();
    const duration = song.duration_ms ?? this.#d.config.max_song_secs * 1000;
    const id = newId();
    this.#d.store.addSession({
      id,
      song_id: song.id,
      person_id: person,
      platform: account.platform,
      account_id: account.id,
      name: safeName(name, 60),
      started_at: toTimestamp(now),
      expires_at: toTimestamp(now + duration * 3 + 30 * 60_000),
      shift,
      room_id: room,
    });
    const exp = now + LINK_MS;
    // A video is read in ranges while it plays: its link lasts the session. One not on Core yet
    // is fetched for the next singing; this one has the still.
    let videoUrl: string | null = null;
    if (song.video && this.#d.config.video) {
      if (await exists(join(this.#dir(song.id), KARAOKE_VIDEO_FILE))) {
        const until = now + duration * 3 + 30 * 60_000;
        videoUrl = this.#signer.url(id, KARAOKE_VIDEO_FILE, account, until);
      } else {
        void this.#fetchVideo(song);
      }
    }
    const cfg = this.#d.config;
    return {
      session: id,
      song: this.#view(song, person, person === null ? undefined : this.#d.store.bestsOf(person)),
      backing_url: this.#signer.url(id, karaokeBackingName(shift) as KaraokeFileName, account, exp),
      reference_url: this.#signer.url(id, "reference.json", account, exp),
      video_url: videoUrl,
      expires_at: toTimestamp(exp),
      tolerance_cents: cfg.tolerance_cents,
      frame_hz: KARAOKE_FRAME_HZ,
      shift,
      recording:
        cfg.voice_score && this.#d.worker() !== null
          ? {
              max_bytes: KARAOKE_VOICE_MAX_BYTES,
              max_seconds: Math.ceil(duration / 1000) + VOICE_SLACK_S,
            }
          : null,
    };
  }

  /**
   * The file a signed link names, for `account`: its path and type, or `null` (the route answers
   * 404 to anything wrong, the same for every reason). The reference of a song with an edit is the
   * edit, from memory.
   */
  async file(
    account: AccountRef,
    session: string,
    name: string,
    exp: string | undefined,
    sig: string | undefined,
  ): Promise<KaraokeServed | null> {
    if (!servable(name)) return null;
    // The video's link lasts its session (at most three times the longest song, and half an hour).
    const longest =
      name === KARAOKE_VIDEO_FILE
        ? this.#d.config.max_song_secs * 3000 + 30 * 60_000 + LINK_MS
        : undefined;
    if (!this.#signer.check(session, name, account, exp, sig, this.#d.now(), longest)) return null;
    const row = this.#d.store.session(session);
    if (row === null || row.platform !== account.platform || row.account_id !== account.id) {
      return null;
    }
    // A backing in another key only for the session sung in it.
    if (name.startsWith("karaoke.k") && name !== karaokeBackingName(row.shift)) return null;
    if (name === KARAOKE_VIDEO_FILE && !this.#d.config.video) return null;
    if (name === "reference.json") {
      const override = this.#d.store.override(row.song_id);
      if (override !== null) {
        return { data: new TextEncoder().encode(override.reference), type: "application/json" };
      }
    }
    const path = join(this.#dir(row.song_id), name);
    if (!(await exists(path))) return null;
    const type = name.endsWith(".json")
      ? "application/json"
      : name === KARAOKE_VIDEO_FILE
        ? "video/mp4"
        : "audio/mp4";
    return { path, type };
  }

  /** The browser's track, once, at the end: Core's score, stored, and her note. */
  async submit(account: AccountRef, sessionId: string, body: Submission): Promise<KaraokeResult> {
    const { person } = this.#person(account);
    const store = this.#d.store;
    const session = store.session(sessionId);
    if (
      session === null ||
      session.platform !== account.platform ||
      session.account_id !== account.id
    ) {
      throw new KaraokeError(404, "沒有這一次的紀錄");
    }
    // A room's round may have made the result from the live stream before the browser's came (a
    // hidden tab submits late): that result is the answer, not a refusal.
    const made = this.#roomResult(session);
    if (made !== null) return made;
    if (session.status !== "open") throw new KaraokeError(409, "這一次已經交過了");
    const now = this.#d.now();
    if (now > Date.parse(session.expires_at)) {
      throw new KaraokeError(
        409,
        session.room_id === null ? "這一次已經過期了" : "這一首已經結算了,這一次沒有算到",
      );
    }
    const song = store.song(session.song_id);
    if (song === null) throw new KaraokeError(404, "沒有這首歌");
    const bytes = fromBase64(body.track);
    if (bytes === null) throw new KaraokeError(400, "音高軌的格式不對");
    // Sung in another key: the reference moves with the backing.
    const reference = shiftKaraokeReference(await this.reference(song.id), session.shift);
    const most = Math.ceil(reference.duration_s * KARAOKE_FRAME_HZ) + 5 * KARAOKE_FRAME_HZ;
    if (bytes.length > most) throw new KaraokeError(400, "音高軌比歌還長");
    // A track takes as long to sing as it is long: one made beforehand arrives too soon.
    const sungMs = (bytes.length / KARAOKE_FRAME_HZ) * 1000;
    if (now - Date.parse(session.started_at) < sungMs - 5000) {
      throw new KaraokeError(409, "這一次的時間對不上,沒有收");
    }
    const lines = reference.lyrics?.lines ?? [];
    const result = scoreSinging({
      ...this.scoreInput(reference, body.latency_ms, body.calibrated),
      sung: { hz: KARAOKE_FRAME_HZ, midi: decodeTrack(bytes) },
    });
    const phraseText = lines.length > 0 ? lines.map((l) => l.text) : [];
    const unranked = result.flags.too_perfect;
    const bestBefore = person === null ? null : (store.bestsOf(person).get(song.id)?.best ?? null);
    // A round of a room: the room tells her of it (all its singers together), not this session.
    const inRoom = session.room_id !== null;
    const context =
      this.#d.config.comment && !inRoom ? commentContext(this.#d.config.comment_channel) : null;
    const speaks = context !== null && result.facts.coverage >= COMMENT_COVERAGE;
    const at = toTimestamp(now);
    // A recording follows, or (a room's singer) the live stream gives the official score: she
    // hears of the song once it is in, or the wait is over.
    const streamed = inRoom && (this.#rooms?.streams(session.id) ?? false);
    const voice: KaraokeVoiceState =
      streamed || (body.recording && this.#d.config.voice_score && this.#d.worker() !== null)
        ? "waiting"
        : "none";
    const detail: StoredDetail = { result, lines: phraseText, latency_ms: body.latency_ms };
    const row: ResultRow = {
      session_id: session.id,
      song_id: song.id,
      person_id: person,
      total: result.total,
      pitch: result.pitch.score,
      stability: result.stability.score,
      rhythm: result.rhythm.score,
      expression: result.expression.score,
      unranked,
      reasons: JSON.stringify(result.flags.reasons),
      detail: JSON.stringify(detail),
      client_total: body.client_total,
      best_before: bestBefore,
      comment_state: speaks ? "waiting" : "none",
      comment: null,
      channel: speaks ? context.channel : null,
      noted_at: voice === "waiting" && !inRoom ? null : at,
      comment_at: null,
      created_at: at,
      source: "estimate",
      voice_state: voice,
      estimate_total: result.total,
      checks: "[]",
    };
    const stored = store.scored(
      {
        session_id: session.id,
        hz: KARAOKE_FRAME_HZ,
        frames: body.track.replace(/\s+/g, ""),
        latency_ms: body.latency_ms,
        calibrated: body.calibrated,
        browser: body.browser.slice(0, 60),
        submitted_at: at,
        purge_at: toTimestamp(now + TRACK_KEEP_MS),
        voice_frames: null,
      },
      row,
      {
        session: session.id,
        song: song.id,
        title: song.title,
        person,
        total: result.total,
        pitch: result.pitch.score,
        stability: result.stability.score,
        rhythm: result.rhythm.score,
        expression: result.expression.score,
        unranked,
        source: "estimate",
      },
    );
    if (!stored) {
      const other = this.#roomResult(session);
      if (other !== null) return other;
      throw new KaraokeError(409, "這一次已經交過了");
    }
    if (inRoom) {
      // The stream's final pitch may have come before the result did.
      const final = this.#rooms?.finalOf(session.id) ?? null;
      if (final !== null) this.streamFinal(session.id, final.pitch, final.offset_ms);
      this.#rooms?.changed(session.id);
      return this.#resultView(store.result(session.id) as ResultRow, song);
    }
    if (voice === "none") this.#tell(store.result(session.id) as ResultRow, session, song);
    if (person !== null && result.facts.coverage >= TOGETHER_COVERAGE) {
      this.#d.together(
        person,
        `在會員頁唱 K 給她聽:「${safeName(song.title, 40)}」${result.total} 分`,
        now,
        session.id,
      );
    }
    return this.#resultView(store.result(session.id) as ResultRow, song);
  }

  /** The result a room's session already has (submitting it again answers with it), else `null`. */
  #roomResult(session: SessionRow): KaraokeResult | null {
    if (session.room_id === null) return null;
    const row = this.#d.store.result(session.id);
    const song = row === null ? null : this.#d.store.song(row.song_id);
    return row === null || song === null ? null : this.#resultView(row, song);
  }

  /** She hears of a result (the estimate, or the official one), once. */
  #tell(row: ResultRow, session: SessionRow, song: SongRow): void {
    const { result, lines } = JSON.parse(row.detail) as StoredDetail;
    const context = row.channel === null ? null : commentContext(this.#d.config.comment_channel);
    try {
      this.#d.tell({
        summary: resultNote({
          name: session.name,
          title: song.title,
          result,
          lines,
          bestBefore: row.best_before,
        }),
        key: `karaoke:${session.id}`,
        person: row.person_id as PersonId | null,
        context: context !== null && context.channel === row.channel ? context : null,
      });
    } catch (error) {
      this.#d.log.warn({ err: errorText(error) }, "karaoke: cannot tell her about a song");
    }
  }

  /** Tells her of the results that waited for their recording, once it is in or the wait is over. */
  #notesDue(): void {
    const store = this.#d.store;
    const now = this.#d.now();
    for (const row of store.voiceOverdue(now - VOICE_UPLOAD_MS)) store.voiceFailed(row.session_id);
    const waitMs = this.#d.config.voice_wait_secs * 1000;
    for (const row of store.untold()) {
      const pending = row.voice_state === "waiting" || row.voice_state === "scoring";
      if (pending && now - Date.parse(row.created_at) < waitMs) continue;
      this.#noteNow(row.session_id);
    }
  }

  /** Tells her of a session's result as it is now, unless she was told already. */
  #noteNow(sessionId: string): void {
    const store = this.#d.store;
    const now = this.#d.now();
    const session = store.session(sessionId);
    const row = store.result(sessionId);
    const song = row === null ? null : store.song(row.song_id);
    if (session === null || row === null || song === null) return;
    if (!store.markNoted(sessionId, now)) return;
    this.#tell(store.result(sessionId) as ResultRow, session, song);
  }

  /**
   * The recording of a session, once, after its result: checked here, then read by a song worker
   * and scored in the background (`voiceSettled` waits for it). `offsetMs`: the song time of the
   * recording's first sample, as the browser's clock saw it.
   */
  voice(
    account: AccountRef,
    sessionId: string,
    bytes: Uint8Array,
    type: string,
    offsetMs: number,
  ): KaraokeVoiceAccepted {
    this.#person(account);
    const store = this.#d.store;
    const session = store.session(sessionId);
    if (
      session === null ||
      session.platform !== account.platform ||
      session.account_id !== account.id
    ) {
      throw new KaraokeError(404, "沒有這一次的紀錄");
    }
    const row = store.result(sessionId);
    if (row === null) throw new KaraokeError(409, "先交這一次的結果");
    if (row.voice_state !== "waiting") throw new KaraokeError(409, "這一次不收錄音了");
    const kind = type.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!(VOICE_TYPES as readonly string[]).includes(kind)) {
      throw new KaraokeError(415, "錄音的格式不對");
    }
    if (bytes.length === 0) throw new KaraokeError(400, "錄音是空的");
    if (bytes.length > KARAOKE_VOICE_MAX_BYTES) throw new KaraokeError(413, "錄音太大了");
    if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 60_000) {
      throw new KaraokeError(400, "錄音的開始時間不對");
    }
    const worker = this.#d.worker();
    if (worker === null) {
      store.voiceFailed(sessionId);
      this.#noteNow(sessionId);
      throw new KaraokeError(503, "現在沒有能算正式分數的機器,這一次是預估分數");
    }
    if (!store.claimVoice(sessionId)) throw new KaraokeError(409, "這一次不收錄音了");
    const work = this.#scoreVoice(session, bytes, kind, offsetMs).finally(() => {
      this.#voices.delete(sessionId);
    });
    this.#voices.set(sessionId, work);
    return { state: "scoring" };
  }

  /** Every recording being scored is done (tests, and a module stopping). */
  async voiceSettled(): Promise<void> {
    await Promise.allSettled([...this.#voices.values()]);
  }

  /** Every file being fetched onto Core (a song's, its video) is in or given up (tests). */
  async filesSettled(): Promise<void> {
    await Promise.allSettled([...this.#fetching.values(), ...this.#videos.values()]);
  }

  /** What every score of a song is scored against (the reference already in the session's key). */
  scoreInput(
    reference: WorkersKaraokeReferenceV2,
    latencyMs: number,
    calibrated: boolean,
  ): Omit<ScoreInput, "sung"> {
    const lines = reference.lyrics?.lines ?? [];
    return {
      reference: {
        hz: reference.pitch.hz,
        start: reference.pitch.start,
        midi: reference.pitch.midi,
      },
      latency_ms: latencyMs,
      calibrated,
      phrases: lines.length > 0 ? lines.map((l) => ({ start: l.start, end: l.end })) : null,
      tuning: { tolerance_cents: this.#d.config.tolerance_cents },
    };
  }

  /** The rooms (`rooms.ts`), which this tells of their sessions' results. */
  attachRooms(rooms: RoomLink | null): void {
    this.#rooms = rooms;
  }

  /**
   * The final pitch of a room singer's live stream (`offsetMs`: the song time of its first
   * sample): scored as the official result, once, if the result is in and waiting for it (else the
   * room hands it over again when the result comes).
   */
  streamFinal(sessionId: string, pitch: WorkersKaraokeVoicePitch, offsetMs: number): void {
    const store = this.#d.store;
    const session = store.session(sessionId);
    const row = store.result(sessionId);
    if (session === null || row === null || row.voice_state !== "waiting") return;
    if (!store.claimVoice(sessionId)) return;
    // The stream's samples are on the browser's own audio clock: placed as they are, no slide.
    const work = this.#scorePitch(session, pitch, offsetMs, 0).finally(() => {
      this.#voices.delete(sessionId);
    });
    this.#voices.set(sessionId, work);
  }

  /** A room singer's stream will not give the official score after all: the result waits no more. */
  streamLost(sessionId: string): void {
    const row = this.#d.store.result(sessionId);
    if (row === null || row.voice_state !== "waiting") return;
    // The browser is told (`voice.upload`) to send its recording; that is waited for as alone.
    this.#rooms?.changed(sessionId);
  }

  async #scoreVoice(
    session: SessionRow,
    bytes: Uint8Array,
    type: string,
    offsetMs: number,
  ): Promise<void> {
    let pitch: WorkersKaraokeVoicePitch;
    try {
      const worker = this.#d.worker();
      if (worker === null) throw new Error("no song worker");
      try {
        pitch = await worker.voice({ bytes, type }, AbortSignal.timeout(VOICE_READ_MS));
      } finally {
        bytes.fill(0); // nothing of the recording stays in Core's memory past this
      }
    } catch (error) {
      this.#d.log.warn(
        { session: session.id, err: errorText(error) },
        "karaoke: the recording was not read",
      );
      this.#d.store.voiceFailed(session.id);
      this.#noteNow(session.id);
      this.#rooms?.changed(session.id);
      return;
    }
    await this.#scorePitch(session, pitch, offsetMs, 500);
  }

  /**
   * A singer's pitch from the song worker (`pitch`, from its first sample at `offsetMs` of song
   * time, slid within `rangeMs` to fit the browser's track) scored as the official result.
   */
  async #scorePitch(
    session: SessionRow,
    pitch: WorkersKaraokeVoicePitch,
    offsetMs: number,
    rangeMs: number,
  ): Promise<void> {
    const store = this.#d.store;
    const id = session.id;
    try {
      const song = store.song(session.song_id);
      const track = store.track(id);
      const row = store.result(id);
      if (song === null || track === null || row === null) throw new Error("the session is gone");
      const reference = shiftKaraokeReference(await this.reference(song.id), session.shift);
      if (pitch.seconds > reference.duration_s + VOICE_SLACK_S) {
        throw new Error(
          `a recording of ${pitch.seconds} s for a song of ${reference.duration_s} s`,
        );
      }
      const live = {
        hz: track.hz,
        midi: decodeTrack(fromBase64(track.frames) ?? new Uint8Array()),
      };
      const recorded = { hz: pitch.hz, midi: pitch.midi };
      const placed = placeRecording(live, recorded, offsetMs, rangeMs);
      const inSong = recordingInSong(recorded, placed.offset_ms);
      const input = this.scoreInput(reference, track.latency_ms, track.calibrated);
      const curve = input.reference;
      const lines = reference.lyrics?.lines ?? [];
      const result = scoreSinging({ ...input, sung: { hz: KARAOKE_FRAME_HZ, midi: inSong } });
      const checked = voiceChecks(
        curve,
        alignSung(curve, { hz: KARAOKE_FRAME_HZ, midi: inSong }, track.latency_ms),
        { level_db: pitch.level_db, floor_db: pitch.floor_db },
      );
      const reasons = [
        ...result.flags.reasons,
        ...checked.checks.map((c) =>
          c === "quiet"
            ? `quiet voice (${pitch.level_db ?? "?"} dBFS, ${checked.above_floor_db ?? "?"} dB over its floor)`
            : `pitch in the song's rests (${Math.round((checked.rest_voiced ?? 0) * 100)}%): backing from speakers?`,
        ),
        ...(placed.found ? [] : ["recording placed by the browser's start only"]),
      ];
      const unranked = result.flags.too_perfect || checked.checks.length > 0;
      const detail: StoredDetail = {
        result,
        lines: lines.length > 0 ? lines.map((l) => l.text) : [],
        latency_ms: track.latency_ms,
        voice: {
          offset_ms: Math.round(placed.offset_ms),
          agreed: placed.agreed,
          found: placed.found,
          device: pitch.device,
          level_db: pitch.level_db,
          floor_db: pitch.floor_db,
          rest_voiced: checked.rest_voiced,
        },
      };
      const scored = store.voiceScored(
        id,
        {
          total: result.total,
          pitch: result.pitch.score,
          stability: result.stability.score,
          rhythm: result.rhythm.score,
          expression: result.expression.score,
          unranked,
          reasons: JSON.stringify(reasons),
          detail: JSON.stringify(detail),
          checks: JSON.stringify(checked.checks),
        },
        toBase64(encodeTrack(inSong)),
        {
          session: id,
          song: song.id,
          title: song.title,
          person: row.person_id,
          total: result.total,
          pitch: result.pitch.score,
          stability: result.stability.score,
          rhythm: result.rhythm.score,
          expression: result.expression.score,
          unranked,
          source: "voice",
        },
        this.#d.now(),
      );
      if (scored) {
        this.#d.log.info(
          { session: id, total: result.total, estimate: row.estimate_total, device: pitch.device },
          "karaoke: official score from the recording",
        );
      }
    } catch (error) {
      this.#d.log.warn(
        { session: id, err: errorText(error) },
        "karaoke: the recording was not scored",
      );
      store.voiceFailed(id);
    }
    this.#noteNow(id);
    this.#rooms?.changed(id);
  }

  /** A result of the member's own. */
  result(account: AccountRef, sessionId: string): KaraokeResult {
    this.#person(account);
    const store = this.#d.store;
    const session = store.session(sessionId);
    const row = store.result(sessionId);
    if (
      session === null ||
      row === null ||
      session.platform !== account.platform ||
      session.account_id !== account.id
    ) {
      throw new KaraokeError(404, "沒有這一次的紀錄");
    }
    const song = store.song(row.song_id);
    if (song === null) throw new KaraokeError(404, "沒有這首歌");
    return this.#resultView(row, song);
  }

  #resultView(row: ResultRow, song: SongRow): KaraokeResult {
    const { result, lines, latency_ms } = JSON.parse(row.detail) as StoredDetail;
    const room = this.#d.store.session(row.session_id)?.room_id ?? null;
    const streamed = room !== null && (this.#rooms?.streams(row.session_id) ?? false);
    return {
      session: row.session_id,
      source: row.source === "voice" ? "voice" : "estimate",
      voice: {
        state: row.voice_state as KaraokeVoiceState,
        estimate_total: row.source === "voice" ? row.estimate_total : null,
        checks: JSON.parse(row.checks) as KaraokeVoiceCheck[],
        upload: row.voice_state === "waiting" && !streamed,
      },
      song: { id: song.id, title: song.title, artist: song.artist },
      at: row.created_at,
      total: result.total,
      pitch: result.pitch,
      stability: result.stability,
      rhythm: result.rhythm,
      expression: result.expression,
      phrases: result.phrases.map((p) => ({ ...p, text: lines[p.index] ?? null })),
      facts: result.facts,
      unranked: row.unranked,
      client_total: row.client_total,
      latency_ms,
      best_before: row.best_before,
      comment: { state: row.comment_state as KaraokeResult["comment"]["state"], text: row.comment },
    };
  }

  // ---- her comment ----------------------------------------------------------------------------

  /**
   * She finished a turn in `context` with `text`: when a result there is waiting for her comment
   * (told within `COMMENT_WAIT_MS`), the oldest takes it. A guess by place and time, so only the
   * first turn after the note counts.
   */
  heard(context: ContextKey, text: string): void {
    const want = commentContext(this.#d.config.comment_channel);
    if (want === null || context.kind !== "channel" || context.channel !== want.channel) return;
    if (context.platform !== want.platform || text.trim() === "") return;
    const now = this.#d.now();
    const [first] = this.#d.store.waitingIn(want.channel, now - COMMENT_WAIT_MS);
    if (first === undefined) return;
    this.#d.store.setComment(first.session_id, "said", text.trim().slice(0, 1000), now);
  }

  // ---- upkeep ---------------------------------------------------------------------------------

  async #upkeep(): Promise<void> {
    const now = this.#d.now();
    const store = this.#d.store;
    store.purgeTracks(now);
    store.giveUpComments(now - COMMENT_WAIT_MS);
    const videoKeep = this.#d.config.video_keep_hours * 3_600_000;
    if (videoKeep < FILES_KEEP_MS || !this.#d.config.video) {
      // Videos go sooner than the rest (or at once when videos are off).
      for (const song of store.idleReady(now - (this.#d.config.video ? videoKeep : 0))) {
        if (this.#videos.has(song.id)) continue;
        await rm(join(this.#dir(song.id), KARAOKE_VIDEO_FILE), { force: true }).catch(() => {});
      }
    }
    for (const song of store.idleReady(now - Math.max(FILES_KEEP_MS, videoKeep))) {
      if (this.#fetching.has(song.id) || this.#videos.has(song.id)) continue;
      const dir = this.#dir(song.id);
      if (!(await exists(dir))) continue;
      this.#parsed.delete(song.id);
      await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
        this.#d.log.warn({ song: song.id, err: errorText(error) }, "karaoke: cannot clear files");
      });
    }
  }

  // ---- the reference editor (step 6) ----------------------------------------------------------

  /** A ready song a panel admin may edit: a refusal otherwise. */
  #editable(account: AccountRef, songId: string, admin: boolean): SongRow {
    if (!admin) throw new KaraokeError(403, "只有管理員能改歌詞和音符");
    this.#person(account);
    const song = this.#d.store.song(songId);
    if (song === null) throw new KaraokeError(404, "沒有這首歌");
    if (song.status !== "ready") throw new KaraokeError(409, "這首還沒準備好");
    return song;
  }

  /** `workerReference`, its file missing a refusal for people. */
  async #workerOf(song: SongRow): Promise<{ reference: WorkersKaraokeReferenceV2; hash: string }> {
    try {
      return await this.workerReference(song.id);
    } catch (error) {
      if (error instanceof KaraokeError) throw error;
      this.#d.log.warn({ song: song.id, err: errorText(error) }, "karaoke: the files are gone");
      throw new KaraokeError(503, "這首的檔案現在拿不到,等一下再試");
    }
  }

  /** The editor's view of a song: as it is sung now, the worker's, the edit and its record. */
  async #editView(song: SongRow): Promise<KaraokeEditView> {
    const store = this.#d.store;
    const worker = await this.#workerOf(song);
    let reference: WorkersKaraokeReferenceV2;
    try {
      reference = await this.reference(song.id);
    } catch (error) {
      if (error instanceof KaraokeError) throw error;
      throw new KaraokeError(503, "這首的檔案現在拿不到,等一下再試");
    }
    const edit = store.override(song.id);
    return {
      song: {
        id: song.id,
        title: song.title || song.source,
        artist: song.artist,
        duration_s: reference.duration_s,
      },
      reference,
      original: { lyrics: worker.reference.lyrics, notes: worker.reference.notes, pitch_shift: 0 },
      edit:
        edit === null
          ? { revision: 0, pitch_shift: 0, saved_by: null, saved_at: null, worker_changed: false }
          : {
              revision: edit.revision,
              pitch_shift: edit.pitch_shift,
              saved_by: edit.saved_name,
              saved_at: edit.saved_at,
              worker_changed: edit.worker_hash !== null && edit.worker_hash !== edit.base_hash,
            },
      history: store.edits(song.id, EDIT_HISTORY).map((e) => ({
        action: e.action === "restore" ? ("restore" as const) : ("save" as const),
        name: e.name,
        at: e.at,
        revision: e.revision,
        lines: e.lines,
        notes: e.notes,
        pitch_shift: e.pitch_shift,
      })),
      results: store.resultsOn(song.id),
      backing_url: `${EDIT_BACKING_ROUTE}/${encodeURIComponent(song.id)}/backing`,
    };
  }

  /** The reference editor's view of a ready song (panel admins only). */
  async editor(account: AccountRef, songId: string, admin: boolean): Promise<KaraokeEditView> {
    return this.#editView(this.#editable(account, songId, admin));
  }

  /**
   * A panel admin's edit saved as the song's reference, over the revision they edited (`0`: the
   * worker's). Checked with the editor's own rules and refused with the problems (never mended);
   * built on the worker's reference as it is now. Results already recorded stay as they were.
   */
  async saveEdit(
    account: AccountRef,
    name: string,
    songId: string,
    body: KaraokeEditSave,
    admin: boolean,
  ): Promise<KaraokeEditView> {
    const song = this.#editable(account, songId, admin);
    const { person } = this.#person(account);
    const store = this.#d.store;
    if ((store.override(song.id)?.revision ?? 0) !== body.revision) {
      throw new KaraokeError(409, "有人在你之後存過了,重新載入再改");
    }
    const doc: EditDoc = { lyrics: body.lyrics, notes: body.notes, pitch_shift: body.pitch_shift };
    if (JSON.stringify(doc).length > EDIT_LIMITS.bytes) {
      throw new KaraokeError(400, "改的內容太大了");
    }
    const worker = await this.#workerOf(song);
    const problems = validateEdit(
      doc,
      { duration_s: worker.reference.duration_s, curve: worker.reference.pitch.midi },
      Number.POSITIVE_INFINITY,
    );
    if (problems.length > 0) {
      const shown = problems.slice(0, EDIT_PROBLEMS_SHOWN).map((p) => p.message);
      const more = problems.length - shown.length;
      throw new KaraokeError(400, `${shown.join("；")}${more > 0 ? `(還有 ${more} 個問題)` : ""}`);
    }
    const composed = composeReference(worker.reference, doc);
    const lines = editedLines(composed.lyrics?.lines ?? []);
    const revision = store.saveOverride(
      song.id,
      body.revision,
      {
        reference: JSON.stringify(composed),
        pitch_shift: doc.pitch_shift,
        base_hash: worker.hash,
        worker_hash: worker.hash,
      },
      { lines, notes: composed.notes.length },
      sungOf(composed),
      { person, name: safeName(name, 60), at: this.#d.now() },
    );
    this.#changed(song.id);
    if (revision === null) throw new KaraokeError(409, "有人在你之後存過了,重新載入再改");
    this.#d.log.info(
      { song: song.id, revision, lines, notes: composed.notes.length, shift: doc.pitch_shift },
      "karaoke: a reference edit saved",
    );
    return this.#editView(store.song(song.id) as SongRow);
  }

  /** The song's edit dropped: the worker's reference is sung again. */
  async restoreEdit(
    account: AccountRef,
    name: string,
    songId: string,
    revision: number,
    admin: boolean,
  ): Promise<KaraokeEditView> {
    const song = this.#editable(account, songId, admin);
    const { person } = this.#person(account);
    const store = this.#d.store;
    const edit = store.override(song.id);
    if (edit === null) throw new KaraokeError(409, "這首沒有改過");
    if (edit.revision !== revision) {
      throw new KaraokeError(409, "有人在你之後存過了,重新載入再改");
    }
    const worker = await this.#workerOf(song);
    const done = store.dropOverride(song.id, revision, sungOf(worker.reference), {
      person,
      name: safeName(name, 60),
      at: this.#d.now(),
    });
    this.#changed(song.id);
    if (done === "none") throw new KaraokeError(409, "這首沒有改過");
    if (done === "moved") throw new KaraokeError(409, "有人在你之後存過了,重新載入再改");
    this.#d.log.info({ song: song.id, revision }, "karaoke: a reference edit restored");
    return this.#editView(store.song(song.id) as SongRow);
  }

  /** The backing track the editor plays, as a path on Core (fetched when it is not), or `null`. */
  async editBacking(account: AccountRef, songId: string, admin: boolean): Promise<string | null> {
    const song = this.#editable(account, songId, admin);
    try {
      await this.#fetch(song);
    } catch (error) {
      this.#d.log.warn({ song: song.id, err: errorText(error) }, "karaoke: the files are gone");
      return null;
    }
    const path = join(this.#dir(song.id), "karaoke.m4a");
    return (await exists(path)) ? path : null;
  }

  // ---- the owner's look -----------------------------------------------------------------------

  /**
   * The latest results for the panel. `space`: only the rooms of that server beside the results
   * sung alone; left out: all.
   */
  adminResults(limit = 50, space?: string): KaraokeAdminResults {
    const rows = this.#d.store
      .latest(limit)
      .filter((r) => space === undefined || r.space === null || r.space === space);
    return {
      results: rows.map((r) => ({
        session: r.session_id,
        person: r.person_id,
        name: r.name,
        song: r.song_id,
        title: r.title,
        total: r.total,
        client_total: r.client_total,
        unranked: r.unranked,
        reasons: JSON.parse(r.reasons) as string[],
        source: r.source === "voice" ? ("voice" as const) : ("estimate" as const),
        voice_state: r.voice_state as KaraokeVoiceState,
        estimate_total: r.estimate_total,
        latency_ms: r.track?.latency_ms ?? 0,
        calibrated: r.track?.calibrated ?? false,
        browser: r.track?.browser ?? "",
        at: r.created_at,
        space: r.space,
      })),
    };
  }

  /** A song worker is there to prepare songs. */
  hasWorker(): boolean {
    return this.#d.worker() !== null;
  }

  /** For the card: songs ready and being prepared. */
  counts(): { ready: number; preparing: number } {
    return {
      ready: this.#d.store.songsIn("ready", 10_000).length,
      preparing: this.#d.store.songsIn("preparing").length,
    };
  }
}

/** What a result row keeps as `detail`. */
interface StoredDetail {
  result: ScoreResult;
  lines: (string | null)[];
  latency_ms: number;
  /** How the recording was placed and what was heard (the official score only), for the owner. */
  voice?: {
    offset_ms: number;
    agreed: number;
    found: boolean;
    device: string;
    level_db: number | null;
    floor_db: number | null;
    rest_voiced: number | null;
  };
}

function tooLong(maxSecs: number): string {
  return `這首太長了(最多 ${Math.round((maxSecs / 60) * 10) / 10} 分鐘)`;
}

/** A sentence for people from the worker's own words. */
export function failureText(error: string | null, maxSecs: number): string {
  const e = (error ?? "").toLowerCase();
  if (e.includes("host") || e.includes("not allowed") || e.includes("unsupported url")) {
    return "這個網站的連結不能用,換一個或改打歌名";
  }
  if (e.includes("too long") || e.includes("longer than")) return tooLong(maxSecs);
  if (e.includes("no result") || e.includes("not found") || e.includes("no video")) {
    return "找不到這首歌,換個寫法試試";
  }
  if (e === "cancelled") return "準備被取消了,可以再點一次";
  return "準備失敗了,可以再點一次";
}

/** SHA-256 of a file's bytes, hex. */
function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What the song row says of a reference that is sung: whether it has lyrics, whose, its notes. */
function sungOf(ref: WorkersKaraokeReferenceV2): SongSung {
  const lyrics = ref.lyrics !== null && ref.lyrics.lines.length > 0;
  return {
    lyrics,
    lyrics_source: lyrics ? (ref.lyrics?.source ?? null) : null,
    notes: ref.notes.length,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
