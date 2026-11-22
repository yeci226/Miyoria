// `@miyoria/play/karaoke/testing`: what the karaoke tests and the offline end-to-end check use: the
// synthetic songs and singers (`synth.ts`), a reference in the worker's format made from a
// synthetic song, and a song worker in memory that prepares karaoke jobs when told to.

import { writeFile } from "node:fs/promises";
import {
  KARAOKE_REFERENCE_FORMAT,
  KARAOKE_STREAM_RATE,
  karaokeBackingName,
  type WorkersKaraokeReference,
  type WorkersKaraokeReferenceV1,
  type WorkersKaraokeReferenceV2,
  type WorkersKaraokeStreamAnswer,
  type WorkersKaraokeStreamFrames,
  type WorkersKaraokeStreamRequest,
  type WorkersKaraokeVoicePitch,
  type WorkersSingJob,
} from "@miyoria/contracts/workers";
import type {
  AccountRef,
  KaraokeCharge,
  KaraokeFileName,
  KaraokePaid,
  KaraokePayoutKind,
  KaraokeQuery,
  KaraokeVoice,
  KaraokeWallet,
  KaraokeWorker,
  Timestamp,
} from "@miyoria/types";
import type { SynthSong } from "./synth.js";

export {
  copySinger,
  humanSinger,
  noiseSinger,
  rng,
  type SingerOptions,
  type SynthNote,
  type SynthSong,
  silentSinger,
  synthSong,
} from "./synth.js";

/**
 * `song` as the worker's `reference.json` (version 2): looked-up lyrics, every line matched but
 * none aligned, the notes cut from the pitch alone. `heard`: the lyrics are a transcription.
 */
export function referenceOf(
  song: SynthSong,
  id = "k-test",
  title = "測試的歌",
  heard = false,
): WorkersKaraokeReferenceV2 {
  const v1 = referenceV1Of(song, id, title);
  return {
    ...v1,
    version: 2,
    lyrics: {
      provider: heard ? null : "test",
      source: heard ? "heard" : "found",
      language: "zh",
      timing: "line",
      check: heard
        ? null
        : { matched: song.lines.length, uncertain: 0, failed: 0, verdict: "kept" },
      lines: song.lines.map((l) => ({
        start: l.start,
        end: l.end,
        text: l.text,
        status: heard ? "uncertain" : "matched",
        source: heard ? "heard" : "found",
        similarity: heard ? null : 1,
        heard: l.text,
        aligned: false,
        pieces: null,
        edited: false,
      })),
    },
    made: {
      ...v1.made,
      lyrics: heard ? "heard" : "found-checked",
      asr: "qwen3-asr-1.7b",
      aligner: "w2v",
    },
  };
}

/** `song` as a step 1 worker wrote `reference.json` (version 1). */
export function referenceV1Of(
  song: SynthSong,
  id = "k-test",
  title = "測試的歌",
): WorkersKaraokeReferenceV1 {
  const { reference } = song;
  const voiced = reference.midi.filter((m) => m !== null).length;
  return {
    format: KARAOKE_REFERENCE_FORMAT,
    version: 1,
    id,
    title,
    artist: "某人",
    duration_s: reference.midi.length / reference.hz,
    backing: "karaoke.m4a",
    pitch: {
      hz: reference.hz,
      start: reference.start,
      midi: reference.midi.map((m) => (m === null ? null : Math.round(m * 100) / 100)),
    },
    notes: song.notes.map((n) => ({
      start: n.start,
      end: n.end,
      midi: n.midi,
      source: "pitch",
      line: null,
      char: null,
    })),
    lyrics: {
      provider: "test",
      timing: "line",
      lines: song.lines.map((l) => ({
        start: l.start,
        end: l.end,
        text: l.text,
        check: "unchecked",
        confidence: null,
        chars: null,
      })),
    },
    quality: {
      ok: true,
      reason: null,
      voiced_ratio: voiced / reference.midi.length,
      notes: song.notes.length,
      lead_split: true,
    },
    made: { pitch: "rmvpe", notes: "pitch-runs-1", lyrics: "line" },
  };
}

/** A few bytes standing in for the backing track. */
export const FAKE_BACKING = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

/** A few bytes standing in for a background video. */
export const FAKE_VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);

/**
 * A song worker in memory: jobs wait until `finish` or `fail`; files are written from memory; a
 * recording is "read" by `readVoice` (the test's), else it fails as a worker that is down would.
 */
export class FakeKaraokeWorker implements KaraokeWorker {
  readonly jobs = new Map<string, WorkersSingJob>();
  readonly references = new Map<string, WorkersKaraokeReference>();
  readonly asked: KaraokeQuery[] = [];
  readonly fetched: string[] = [];
  /** How many of the next file transfers break (the link dropped). */
  breakFiles = 0;
  /** `song/semitones` of every key asked for. */
  readonly keys: string[] = [];
  /** The next `key` fails. */
  keyFails = false;
  /** The next `prepare` answers this error. */
  refuse: { message: string; status?: number } | null = null;
  /** Songs that have a background video. */
  readonly videos = new Set<string>();
  /** The recordings it was sent (their sizes and types; the bytes as they were when sent). */
  readonly voices: { size: number; type: string; bytes: Uint8Array }[] = [];
  /** How a recording is read; `null`: the worker cannot be reached. */
  readVoice:
    | ((voice: KaraokeVoice) => WorkersKaraokeVoicePitch | Promise<WorkersKaraokeVoicePitch>)
    | null = null;
  #next = 1;

  async prepare(query: KaraokeQuery): Promise<WorkersSingJob> {
    if (this.refuse !== null) {
      const error = Object.assign(new Error(this.refuse.message), {
        status: this.refuse.status ?? 0,
      });
      throw error;
    }
    this.asked.push(query);
    const id = `kj-${this.#next++}`;
    const job: WorkersSingJob = {
      id,
      state: "queued",
      stage: "queued",
      progress: 0,
      error: null,
      song_id: null,
      cached: false,
      position: 0,
      source: { title: query.query ?? "連結的歌", artist: null },
      song: null,
      exclusive: null,
      gpu: null,
      karaoke: null,
    };
    this.jobs.set(id, job);
    return structuredClone(job);
  }

  async job(id: string): Promise<WorkersSingJob> {
    const job = this.jobs.get(id);
    if (job === undefined) throw Object.assign(new Error(`no job ${id}`), { status: 404 });
    return structuredClone(job);
  }

  async cancel(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  /** The job runs: a stage and how far. */
  progress(id: string, stage: string, progress: number): void {
    Object.assign(this.jobs.get(id) ?? {}, { state: "running", stage, progress, position: null });
  }

  /** The job is done with `reference` (its id is the karaoke song's), with a video when `video`. */
  finish(id: string, reference: WorkersKaraokeReference, video = false): void {
    this.references.set(reference.id, reference);
    if (video) this.videos.add(reference.id);
    Object.assign(this.jobs.get(id) ?? {}, {
      state: "done",
      stage: "done",
      progress: 1,
      position: null,
      karaoke: {
        id: reference.id,
        title: reference.title,
        artist: reference.artist,
        duration_s: reference.duration_s,
        quality: reference.quality,
        video,
      },
    });
  }

  fail(id: string, error: string): void {
    Object.assign(this.jobs.get(id) ?? {}, { state: "failed", error, position: null });
  }

  async file(song: string, name: KaraokeFileName, dest: string): Promise<void> {
    const reference = this.references.get(song);
    if (reference === undefined) {
      throw Object.assign(new Error(`no karaoke ${song}`), { status: 404 });
    }
    if (name === "video.mp4" && !this.videos.has(song)) {
      throw Object.assign(new Error(`karaoke ${song} has no video`), { status: 404 });
    }
    if (this.breakFiles > 0) {
      this.breakFiles--;
      throw new Error("the link dropped");
    }
    this.fetched.push(`${song}/${name}`);
    await writeFile(
      dest,
      name === "reference.json"
        ? JSON.stringify(reference)
        : name === "video.mp4"
          ? FAKE_VIDEO
          : FAKE_BACKING,
    );
  }

  async voice(voice: KaraokeVoice): Promise<WorkersKaraokeVoicePitch> {
    this.voices.push({ size: voice.bytes.length, type: voice.type, bytes: voice.bytes.slice() });
    if (this.readVoice === null) {
      throw Object.assign(new Error("song worker unreachable"), { unreachable: true });
    }
    return this.readVoice(voice);
  }

  /**
   * The live voice streams (`stream`): `missing` answers 404 as a worker predating it, `down` as
   * one that cannot be reached, `slow` never answers before the caller gives up. `live` gives each
   * stream's frames from `streamTracks` (50 Hz from the stream's first sample), as far as the
   * audio sent covers, and the whole of it with `end`.
   */
  streamMode: "live" | "missing" | "down" | "slow" = "live";
  /** Each stream's pitch (by stream id), and its loudness figures for the final answer. */
  readonly streamTracks = new Map<string, (number | null)[]>();
  streamLevels: { level_db: number | null; floor_db: number | null } = {
    level_db: -20,
    floor_db: -60,
  };
  /** Every batch it was sent (the audio's length per chunk, not the audio). */
  readonly batches: {
    room: string;
    chunks: { stream: string; at: number; n: number; end: boolean }[];
  }[] = [];
  readonly #streamSamples = new Map<string, number>();

  async stream(
    request: WorkersKaraokeStreamRequest,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeStreamAnswer> {
    if (this.streamMode === "missing") {
      throw Object.assign(new Error("not found"), { status: 404 });
    }
    if (this.streamMode === "down") {
      throw Object.assign(new Error("song worker unreachable"), { unreachable: true });
    }
    if (this.streamMode === "slow") {
      await new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      });
    }
    const chunks = request.chunks.map((c) => ({
      stream: c.stream,
      at: c.at,
      n: Math.floor((c.audio.replace(/=+$/, "").length * 3) / 4),
      end: c.end ?? false,
    }));
    this.batches.push({ room: request.room, chunks });
    const streams: WorkersKaraokeStreamFrames[] = [];
    for (const c of chunks) {
      const had = this.#streamSamples.get(c.stream) ?? 0;
      const now = Math.max(had, c.at + c.n);
      this.#streamSamples.set(c.stream, now);
      const track = this.streamTracks.get(c.stream) ?? [];
      const upTo = Math.min(track.length, Math.floor((now / KARAOKE_STREAM_RATE) * 50));
      const from = Math.max(0, Math.floor((had / KARAOKE_STREAM_RATE) * 50) - 50);
      streams.push(
        c.end
          ? {
              stream: c.stream,
              from: 0,
              midi: track.slice(0, upTo),
              final: true,
              seconds: now / KARAOKE_STREAM_RATE,
              ...this.streamLevels,
            }
          : {
              stream: c.stream,
              from,
              midi: track.slice(from, upTo),
              final: false,
              seconds: now / KARAOKE_STREAM_RATE,
              level_db: null,
              floor_db: null,
            },
      );
    }
    return { hz: 50, streams, lost: [], device: "cpu", method: "fake" };
  }

  async key(song: string, semitones: number): Promise<{ file: string }> {
    if (!this.references.has(song) || this.keyFails) {
      throw Object.assign(new Error(`no karaoke ${song}`), { status: this.keyFails ? 503 : 404 });
    }
    this.keys.push(`${song}/${semitones}`);
    return { file: karaokeBackingName(semitones) };
  }
}

/**
 * The karaoke wallet in memory, with the economy's rules as `EconomyKaraokeWallet` keeps them: one
 * row per key, a refund keyed on its charge, a day's count per kind, strangers and the blocked
 * refused. Accounts map to people by `people` (`null`: a stranger); `blocked` people cannot pay or
 * be paid. `rows` is the ledger.
 */
export class FakeKaraokeWallet implements KaraokeWallet {
  readonly currency = "魚幣";
  readonly rows: { key: string; person: string; delta: number; reason: string; at: number }[] = [];
  readonly balances = new Map<string, number>();
  readonly blocked = new Set<string>();
  /** The next charge is taken, then throws (a crash or a lost answer after the write). */
  throwAfterCharge = false;
  constructor(
    private readonly people: Record<string, string | null>,
    private readonly now: () => number,
  ) {}

  #person(account: AccountRef): string | null {
    return this.people[account.id] ?? null;
  }

  #usable(account: AccountRef): string | null {
    const p = this.#person(account);
    return p === null || this.blocked.has(p) ? null : p;
  }

  #row(person: string, key: string) {
    return this.rows.find((r) => r.person === person && r.key === key) ?? null;
  }

  #post(person: string, key: string, delta: number, reason: string): void {
    this.rows.push({ key, person, delta, reason, at: this.now() });
    this.balances.set(person, (this.balances.get(person) ?? 0) + delta);
  }

  async balance(account: AccountRef): Promise<number | null> {
    const p = this.#usable(account);
    return p === null ? null : (this.balances.get(p) ?? 0);
  }

  async charge(account: AccountRef, amount: number, key: string): Promise<KaraokeCharge> {
    const p = this.#usable(account);
    if (p === null) return { ok: false, reason: "refused", message: "她還不認識你" };
    const first = this.#row(p, `karaoke_room:${key}`);
    if (first !== null) {
      if (this.#row(p, `refund:${key}`) !== null) {
        return { ok: false, reason: "refused", message: "這筆已經退回了" };
      }
      return { ok: true, receipt: key, balance: this.balances.get(p) ?? 0 };
    }
    const balance = this.balances.get(p) ?? 0;
    if (balance < amount) return { ok: false, reason: "insufficient", balance };
    this.#post(p, `karaoke_room:${key}`, -amount, "karaoke_room");
    if (this.throwAfterCharge) {
      this.throwAfterCharge = false;
      throw new Error("the answer was lost");
    }
    return { ok: true, receipt: key, balance: balance - amount };
  }

  async charged(account: AccountRef, key: string): Promise<boolean> {
    const p = this.#person(account);
    return (
      p !== null &&
      this.#row(p, `karaoke_room:${key}`) !== null &&
      this.#row(p, `refund:${key}`) === null
    );
  }

  async refund(account: AccountRef, key: string): Promise<number> {
    const p = this.#person(account);
    if (p === null) return 0;
    const charge = this.#row(p, `karaoke_room:${key}`);
    if (charge === null || this.#row(p, `refund:${key}`) !== null) return 0;
    this.#post(p, `refund:${key}`, -charge.delta, "karaoke_room_refund");
    return -charge.delta;
  }

  async pay(
    account: AccountRef,
    kind: KaraokePayoutKind,
    amount: number,
    key: string,
    _ref: string | null,
    cap: { since: Timestamp; perDay: number },
  ): Promise<KaraokePaid> {
    const p = this.#usable(account);
    if (p === null || amount <= 0) return { status: "refused", paid: 0 };
    const reason = kind === "prize" ? "karaoke_prize" : "karaoke_finish";
    if (this.#row(p, `${reason}:${key}`) !== null) return { status: "duplicate", paid: 0 };
    const since = Date.parse(cap.since);
    const today = this.rows.filter((r) => r.person === p && r.reason === reason && r.at >= since);
    if (today.length >= cap.perDay) return { status: "capped", paid: 0 };
    this.#post(p, `${reason}:${key}`, amount, reason);
    return { status: "paid", paid: amount };
  }

  /** The rows of `reason` for `person`. */
  of(person: string, reason: string): number[] {
    return this.rows.filter((r) => r.person === person && r.reason === reason).map((r) => r.delta);
  }
}
