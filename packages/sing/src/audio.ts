// Her songs' audio on Core (2026-11-19). A song is sung from the raw PCM the worker made
// (`play_mix.pcm`, and `play_vocals.pcm` for her mouth), tens of MB for a few minutes of song.
// Fetching it when she starts to sing made her sit "singing" in silence while it came over a
// friend's home upload, and longer songs never came in time. So the audio is brought onto Core
// once the worker has made the song, before the song counts as ready, and she sings from here:
// singing never waits for the network, and singing a song again needs no transfer.
//
// `DiskSongAudio` keeps each song in `<dir>/<song id>/` (`audio.json` says which make of the song
// the files are, from what the worker reported about it), within a size budget: the songs used
// longest ago go first, never one that is still in the set list or being fetched. When the
// worker runs on this machine, its own cache (`video_dir`) already holds the files: they are read
// in place and nothing is copied. A transfer that broke is resumed by the next fetch
// (`SingWorker.download` keeps the part), as long as the song is the same make.

import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { pcmOf, type SingWorker, type SongMeta, SongMetaSchema, type SongTrack } from "./client.js";

const log = getLogger("sing");

/** Song ids as the worker writes them (`safe_id`): anything else is never a path here. */
export const SONG_ID = /^[A-Za-z0-9_-]{1,96}$/;

/** Which make of the song a dir's files are (written once they are all there). */
const MARKER = "audio.json";
/** The song's meta, beside its audio: what it is when no worker can be asked (`library`). */
const META = "song.json";
/** The make a dir is being filled with. */
const PENDING = "pending.json";

/** The song's audio is not on Core (any more): fetch it again. */
export class SongAudioMissingError extends Error {
  override readonly name = "SongAudioMissingError";
}

/** Where the module gets a song's audio from. */
export interface SongAudio {
  /** The song's audio is on Core, checked by this process (no I/O). */
  ready(song: SongMeta): boolean;
  /** Brings the song's audio onto Core; one fetch per song at a time. Rejects as the worker does. */
  fetch(song: SongMeta, signal?: AbortSignal): Promise<void>;
  /** One track's samples. `SongAudioMissingError` when it is not on Core. */
  load(song: SongMeta, track: SongTrack, signal?: AbortSignal): Promise<Int16Array>;
  /**
   * The songs whose audio and meta are on Core, newest first, each one `ready` afterwards: what
   * she can sing when no worker answers. Absent: none are kept.
   */
  library?(): Promise<SongMeta[]>;
  /**
   * Brings `songs` onto Core, newest first, as long as they fit the budget with what is there (none
   * is pushed out for them): kept for when no worker answers. Resolves with how many came.
   */
  mirror?(songs: readonly SongMeta[], signal?: AbortSignal): Promise<number>;
}

/** What tells one make of a song from another: the worker's numbers about it, and the tracks. */
export function audioKey(song: SongMeta, tracks: readonly SongTrack[]): string {
  return JSON.stringify({
    id: song.id,
    rate: song.play.sample_rate,
    samples: song.play.samples,
    timings: song.timings,
    tracks,
  });
}

/** Bytes of one track: two per sample, when the worker said how many samples. */
function expectedBytes(song: SongMeta): number | null {
  const n = song.play.samples;
  return n === null || n <= 0 ? null : n * 2;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

function fits(size: number | null, expected: number | null): boolean {
  if (size === null || size === 0 || size % 2 !== 0) return false;
  return expected === null || size === expected;
}

export interface DiskSongAudioOptions {
  /** Where the songs are kept (absolute). */
  dir: string;
  /** The budget of `dir`, in bytes. */
  maxBytes: number;
  worker: SingWorker;
  /** The tracks a song is sung with (the vocals only when her mouth follows them). */
  tracks: readonly SongTrack[];
  /** The song worker's own cache when it may run on this machine; `null`: never looked at. */
  localDir: string | null;
  /** Song ids that must stay: the ones still in the set list. */
  keep: () => ReadonlySet<string>;
}

export class DiskSongAudio implements SongAudio {
  readonly #o: DiskSongAudioOptions;
  /** Songs checked by this process: their make and the dir their files are in. */
  readonly #ready = new Map<string, { key: string; dir: string; cached: boolean }>();
  readonly #fetching = new Map<string, { key: string; work: Promise<void> }>();

  constructor(options: DiskSongAudioOptions) {
    this.#o = options;
  }

  #key(song: SongMeta): string {
    return audioKey(song, this.#o.tracks);
  }

  ready(song: SongMeta): boolean {
    return this.#ready.get(song.id)?.key === this.#key(song);
  }

  fetch(song: SongMeta, signal?: AbortSignal): Promise<void> {
    if (this.ready(song)) return Promise.resolve();
    if (!SONG_ID.test(song.id)) {
      return Promise.reject(
        new Error(`the song id ${JSON.stringify(song.id)} is not one Core keeps`),
      );
    }
    const key = this.#key(song);
    const running = this.#fetching.get(song.id);
    if (running !== undefined && running.key === key) return running.work;
    const work = this.#fetch(song, key, signal).finally(() => {
      if (this.#fetching.get(song.id)?.work === work) this.#fetching.delete(song.id);
    });
    this.#fetching.set(song.id, { key, work });
    return work;
  }

  async load(song: SongMeta, track: SongTrack, signal?: AbortSignal): Promise<Int16Array> {
    const at = this.#ready.get(song.id);
    if (at === undefined || at.key !== this.#key(song) || !this.#o.tracks.includes(track)) {
      throw new SongAudioMissingError(`the audio of ${song.id} is not on Core`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(join(at.dir, track), signal ? { signal } : {});
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#ready.delete(song.id);
      throw new SongAudioMissingError(`${song.id}/${track} is gone: ${errorMessage(error)}`);
    }
    if (!fits(bytes.byteLength, expectedBytes(song))) {
      this.#ready.delete(song.id);
      throw new SongAudioMissingError(`${song.id}/${track} is ${bytes.byteLength} bytes`);
    }
    if (at.cached) {
      // Used now: the last to go when the budget is short.
      const now = new Date();
      await utimes(join(at.dir, MARKER), now, now).catch(() => {});
    }
    return pcmOf(bytes);
  }

  /** Every track is in `dir` at its size. */
  async #complete(dir: string, song: SongMeta): Promise<boolean> {
    const expected = expectedBytes(song);
    for (const track of this.#o.tracks) {
      if (!fits(await sizeOf(join(dir, track)), expected)) return false;
    }
    return true;
  }

  async #fetch(song: SongMeta, key: string, signal?: AbortSignal): Promise<void> {
    const id = song.id;
    // A worker on this machine: its files are already here.
    if (this.#o.localDir !== null && expectedBytes(song) !== null) {
      const local = join(this.#o.localDir, id);
      if (await this.#complete(local, song)) {
        this.#ready.set(id, { key, dir: local, cached: false });
        return;
      }
    }
    const dir = join(this.#o.dir, id);
    const marker = await readFile(join(dir, MARKER), "utf8").catch(() => null);
    if (marker === key && (await this.#complete(dir, song))) {
      this.#ready.set(id, { key, dir, cached: true });
      // Fetched by a Core from before the meta was kept beside the audio.
      await this.#writeMeta(dir, song);
      return;
    }
    // Another make of the song (or none yet): the dir starts over, and a part left by a broken
    // transfer of this same make is resumed.
    const pending = await readFile(join(dir, PENDING), "utf8").catch(() => null);
    if (pending !== key) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, PENDING), key);
    }
    await rm(join(dir, MARKER), { force: true });
    const expected = expectedBytes(song);
    for (const track of this.#o.tracks) {
      const path = join(dir, track);
      if (fits(await sizeOf(path), expected)) continue;
      await this.#o.worker.download(id, track, path, signal);
      const size = await sizeOf(path);
      if (!fits(size, expected)) {
        await rm(path, { force: true });
        throw new Error(
          `${id}/${track} came as ${size ?? 0} bytes, not ${expected ?? "an even number"}`,
        );
      }
    }
    await this.#writeMeta(dir, song);
    await writeFile(join(dir, MARKER), key);
    await rm(join(dir, PENDING), { force: true });
    this.#ready.set(id, { key, dir, cached: true });
    await this.#prune().catch((error: unknown) =>
      log.warn({ err: errorMessage(error) }, "could not clean the songs' audio on Core"),
    );
  }

  async #writeMeta(dir: string, song: SongMeta): Promise<void> {
    await writeFile(join(dir, META), JSON.stringify(song)).catch((error: unknown) =>
      log.warn({ song: song.id, err: errorMessage(error) }, "could not keep the song's meta"),
    );
  }

  async library(): Promise<SongMeta[]> {
    let ids: string[];
    try {
      ids = await readdir(this.#o.dir);
    } catch {
      return [];
    }
    const found: { song: SongMeta; used: number }[] = [];
    for (const id of ids) {
      if (!SONG_ID.test(id)) continue;
      const dir = join(this.#o.dir, id);
      const [marker, raw] = await Promise.all([
        readFile(join(dir, MARKER), "utf8").catch(() => null),
        readFile(join(dir, META), "utf8").catch(() => null),
      ]);
      if (marker === null || raw === null) continue;
      let song: SongMeta;
      try {
        song = SongMetaSchema.parse(JSON.parse(raw));
      } catch {
        continue;
      }
      const key = this.#key(song);
      if (song.id !== id || marker !== key || !(await this.#complete(dir, song))) continue;
      this.#ready.set(id, { key, dir, cached: true });
      const used = (await stat(join(dir, MARKER)).catch(() => null))?.mtimeMs ?? 0;
      found.push({ song, used });
    }
    return found.sort((a, b) => b.used - a.used).map((f) => f.song);
  }

  async mirror(songs: readonly SongMeta[], signal?: AbortSignal): Promise<number> {
    let total = await this.#size();
    let came = 0;
    for (const song of songs) {
      if (signal?.aborted) break;
      if (!SONG_ID.test(song.id)) continue;
      const expected = expectedBytes(song);
      if (expected === null) continue;
      if (this.ready(song)) continue;
      const dir = join(this.#o.dir, song.id);
      const marker = await readFile(join(dir, MARKER), "utf8").catch(() => null);
      if (marker === this.#key(song) && (await this.#complete(dir, song))) {
        // On disk already (counted in `total`), only not checked by this process: its meta is
        // written beside it, nothing is downloaded.
        await this.fetch(song, signal).catch(() => undefined);
        continue;
      }
      const bytes = expected * this.#o.tracks.length;
      // Never push a song out for one nobody asked for.
      if (total + bytes > this.#o.maxBytes) continue;
      try {
        await this.fetch(song, signal);
      } catch (error) {
        if (signal?.aborted) break;
        log.debug({ song: song.id, err: errorMessage(error) }, "could not keep a song on Core");
        continue;
      }
      total += bytes;
      came += 1;
    }
    return came;
  }

  /** Bytes in `dir` now. */
  async #size(): Promise<number> {
    let total = 0;
    let ids: string[];
    try {
      ids = await readdir(this.#o.dir);
    } catch {
      return 0;
    }
    for (const id of ids) {
      let files: string[];
      try {
        files = await readdir(join(this.#o.dir, id));
      } catch {
        continue;
      }
      for (const f of files) total += (await sizeOf(join(this.#o.dir, id, f))) ?? 0;
    }
    return total;
  }

  /** Over the budget: the songs used longest ago go, never one kept or being fetched. */
  async #prune(): Promise<void> {
    const keep = this.#o.keep();
    let total = 0;
    const candidates: { id: string; size: number; used: number }[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.#o.dir);
    } catch {
      return;
    }
    for (const id of entries) {
      const dir = join(this.#o.dir, id);
      let size = 0;
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue; // not a dir
      }
      for (const f of files) size += (await sizeOf(join(dir, f))) ?? 0;
      total += size;
      if (keep.has(id) || this.#fetching.has(id)) continue;
      const used =
        (await stat(join(dir, MARKER)).catch(() => null))?.mtimeMs ??
        (await stat(dir).catch(() => null))?.mtimeMs ??
        0;
      candidates.push({ id, size, used });
    }
    candidates.sort((a, b) => a.used - b.used);
    for (const c of candidates) {
      if (total <= this.#o.maxBytes) break;
      await rm(join(this.#o.dir, c.id), { recursive: true, force: true });
      this.#ready.delete(c.id);
      total -= c.size;
      log.info({ song: c.id, mb: Math.round(c.size / 1e5) / 10 }, "song audio removed from Core");
    }
  }
}

/**
 * The audio in memory, fetched whole from the worker (`SingWorker.audio`): for tests, and for a
 * module without a dir. Keeps the last few songs.
 */
export class MemorySongAudio implements SongAudio {
  readonly #worker: SingWorker;
  readonly #tracks: readonly SongTrack[];
  readonly #songs = new Map<string, { key: string; tracks: Map<SongTrack, Int16Array> }>();

  constructor(
    worker: SingWorker,
    tracks: readonly SongTrack[],
    readonly keepSongs = 4,
  ) {
    this.#worker = worker;
    this.#tracks = tracks;
  }

  ready(song: SongMeta): boolean {
    return this.#songs.get(song.id)?.key === audioKey(song, this.#tracks);
  }

  async fetch(song: SongMeta, signal?: AbortSignal): Promise<void> {
    if (this.ready(song)) return;
    const tracks = new Map<SongTrack, Int16Array>();
    for (const track of this.#tracks) {
      tracks.set(track, await this.#worker.audio(song.id, track, signal));
    }
    this.#songs.delete(song.id);
    this.#songs.set(song.id, { key: audioKey(song, this.#tracks), tracks });
    while (this.#songs.size > this.keepSongs) {
      this.#songs.delete(this.#songs.keys().next().value as string);
    }
  }

  async load(song: SongMeta, track: SongTrack): Promise<Int16Array> {
    const kept = this.#songs.get(song.id);
    const pcm = kept?.key === audioKey(song, this.#tracks) ? kept.tracks.get(track) : undefined;
    if (pcm === undefined) throw new SongAudioMissingError(`the audio of ${song.id} is not here`);
    return pcm;
  }

  /** Forgets a song (tests: the audio went away under the module). */
  forget(id: string): void {
    this.#songs.delete(id);
  }
}
