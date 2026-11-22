// Her songs' audio on Core's disk (`DiskSongAudio`): fetched once from the worker, checked by the
// make of the song, read from the worker's own cache when it runs on this machine, kept within a
// budget with the songs in the set list always kept, and missing again when its files go.

import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DiskSongAudio,
  type SingWorker,
  SingWorkerError,
  SongAudioMissingError,
  type SongMeta,
  type SongTrack,
} from "../src/index.js";

const TRACKS: SongTrack[] = ["play_mix.pcm", "play_vocals.pcm"];

function meta(id: string, samples: number, timings: Record<string, number> = { mix: 1 }): SongMeta {
  return {
    id,
    title: id,
    artist: null,
    duration_s: samples / 48_000,
    lyrics: null,
    play: { sample_rate: 48_000, samples },
    pitch: {},
    timings,
    peak_vram_mb: null,
    has_video: false,
    video: null,
  };
}

function pcm(samples: number, value: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(value, i * 2);
  return b;
}

/** A worker whose `download` writes the track: `samples` of the mix's value 100, vocals 50. */
class DiskWorker {
  readonly downloads: string[] = [];
  /** Samples written per song (to send a wrong size). */
  readonly sizes = new Map<string, number>();
  fail: Error | null = null;

  async download(song: string, file: string, dest: string): Promise<void> {
    if (this.fail !== null) throw this.fail;
    this.downloads.push(`${song}/${file}`);
    const samples = this.sizes.get(song) ?? 1000;
    await writeFile(dest, pcm(samples, file === "play_mix.pcm" ? 100 : 50));
  }
}

let dir: string;
let w: DiskWorker;
let keep: Set<string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sing-audio-"));
  w = new DiskWorker();
  keep = new Set();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(options: { maxBytes?: number; localDir?: string | null } = {}): DiskSongAudio {
  return new DiskSongAudio({
    dir: join(dir, "audio"),
    maxBytes: options.maxBytes ?? 1024 * 1024,
    worker: w as unknown as SingWorker,
    tracks: TRACKS,
    localDir: options.localDir ?? null,
    keep: () => keep,
  });
}

describe("the songs' audio on Core", () => {
  it("keeps_the_meta_beside_the_audio_and_lists_the_kept_songs_newest_first", async () => {
    const a = store();
    await a.fetch(meta("yt-a", 1000));
    await a.fetch(meta("yt-b", 1000));
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dir, "audio", "yt-a", "audio.json"), old, old);
    // Core restarts with no worker: the songs are known from disk alone.
    const again = store();
    const kept = await again.library();
    expect(kept.map((s) => s.id)).toEqual(["yt-b", "yt-a"]);
    expect(again.ready(meta("yt-a", 1000))).toBe(true);
    expect((await again.load(meta("yt-a", 1000), "play_mix.pcm"))[0]).toBe(100);
  });

  it("does_not_list_a_song_whose_audio_is_broken_or_without_meta", async () => {
    const a = store();
    await a.fetch(meta("yt-a", 1000));
    await a.fetch(meta("yt-b", 1000));
    await writeFile(join(dir, "audio", "yt-a", "play_vocals.pcm"), pcm(10, 1));
    await rm(join(dir, "audio", "yt-b", "song.json"));
    await mkdir(join(dir, "audio", "not a song"), { recursive: true });
    expect(await store().library()).toEqual([]);
  });

  it("mirrors_the_worker's_songs_within_the_budget_and_pushes_none_out", async () => {
    // Room for two songs (4000 bytes of audio each, and their small files).
    const a = store({ maxBytes: 9000 });
    const came = await a.mirror([meta("yt-a", 1000), meta("yt-b", 1000), meta("yt-c", 1000)]);
    expect(came).toBe(2);
    expect((await store().library()).map((s) => s.id).sort()).toEqual(["yt-a", "yt-b"]);
    // Already here: nothing fetched again.
    expect(await a.mirror([meta("yt-a", 1000)])).toBe(0);
    expect(w.downloads).toHaveLength(4);
  });

  it("mirror_gives_a_song_on_disk_its_meta_even_when_the_budget_is_full", async () => {
    await store().fetch(meta("yt-a", 1000));
    // Fetched by a Core from before the meta was kept: no song.json, so it cannot be listed.
    await rm(join(dir, "audio", "yt-a", "song.json"));
    expect(await store().library()).toEqual([]);
    // The budget holds what is there and no more.
    const came = await store({ maxBytes: 4100 }).mirror([meta("yt-a", 1000)]);
    expect(came).toBe(0);
    expect((await store().library()).map((s) => s.id)).toEqual(["yt-a"]);
    expect(w.downloads).toHaveLength(2);
  });

  it("fetches a song once, and reads it from disk after", async () => {
    const a = store();
    const song = meta("yt-a", 1000);
    expect(a.ready(song)).toBe(false);
    await expect(a.load(song, "play_mix.pcm")).rejects.toBeInstanceOf(SongAudioMissingError);
    await a.fetch(song);
    expect(a.ready(song)).toBe(true);
    expect(w.downloads).toEqual(["yt-a/play_mix.pcm", "yt-a/play_vocals.pcm"]);
    const mix = await a.load(song, "play_mix.pcm");
    expect(mix.length).toBe(1000);
    expect(mix[999]).toBe(100);
    expect((await a.load(song, "play_vocals.pcm"))[0]).toBe(50);
    await a.fetch(song);
    expect(w.downloads).toHaveLength(2);
    // Core restarts: found on disk, nothing fetched.
    const again = store();
    await again.fetch(song);
    expect(again.ready(song)).toBe(true);
    expect(w.downloads).toHaveLength(2);
  });

  it("one fetch at a time per song", async () => {
    const a = store();
    const song = meta("yt-a", 1000);
    await Promise.all([a.fetch(song), a.fetch(song), a.fetch(song)]);
    expect(w.downloads).toHaveLength(2);
  });

  it("fetches again for another make of the song", async () => {
    const a = store();
    await a.fetch(meta("yt-a", 1000, { mix: 1 }));
    const remade = meta("yt-a", 1000, { mix: 2 });
    expect(a.ready(remade)).toBe(false);
    await expect(a.load(remade, "play_mix.pcm")).rejects.toBeInstanceOf(SongAudioMissingError);
    await a.fetch(remade);
    expect(w.downloads).toHaveLength(4);
  });

  it("refuses a file of the wrong size, and an id that is not a song id", async () => {
    const a = store();
    w.sizes.set("yt-a", 999);
    await expect(a.fetch(meta("yt-a", 1000))).rejects.toThrow(/not 2000/);
    expect(a.ready(meta("yt-a", 1000))).toBe(false);
    await expect(a.fetch(meta("../x", 1000))).rejects.toThrow(/not one Core keeps/);
    w.fail = new SingWorkerError("gone", { status: 404 });
    await expect(a.fetch(meta("yt-b", 1000))).rejects.toMatchObject({ status: 404 });
  });

  it("reads a worker on this machine in place", async () => {
    const local = join(dir, "worker");
    await mkdir(join(local, "yt-a"), { recursive: true });
    await writeFile(join(local, "yt-a", "play_mix.pcm"), pcm(1000, 7));
    await writeFile(join(local, "yt-a", "play_vocals.pcm"), pcm(1000, 8));
    // Another song only half there (or of another length) is fetched.
    await mkdir(join(local, "yt-b"), { recursive: true });
    await writeFile(join(local, "yt-b", "play_mix.pcm"), pcm(500, 7));
    const a = store({ localDir: local });
    await a.fetch(meta("yt-a", 1000));
    await a.fetch(meta("yt-b", 1000));
    expect(w.downloads).toEqual(["yt-b/play_mix.pcm", "yt-b/play_vocals.pcm"]);
    expect((await a.load(meta("yt-a", 1000), "play_mix.pcm"))[0]).toBe(7);
    expect((await a.load(meta("yt-b", 1000), "play_mix.pcm"))[0]).toBe(100);
  });

  it("a song whose files went is missing, and is fetched again", async () => {
    const a = store();
    const song = meta("yt-a", 1000);
    await a.fetch(song);
    await rm(join(dir, "audio", "yt-a"), { recursive: true });
    await expect(a.load(song, "play_mix.pcm")).rejects.toBeInstanceOf(SongAudioMissingError);
    expect(a.ready(song)).toBe(false);
    await a.fetch(song);
    expect((await a.load(song, "play_mix.pcm"))[0]).toBe(100);
  });

  it("keeps within its budget: the song used longest ago goes, never one in the set list", async () => {
    // Each song is 4 000 bytes of audio; the budget holds two.
    const a = store({ maxBytes: 9_000 });
    const songs = ["yt-a", "yt-b", "yt-c", "yt-d"].map((id) => meta(id, 1000));
    const [sa, sb, sc, sd] = songs as [SongMeta, SongMeta, SongMeta, SongMeta];
    await a.fetch(sa);
    await a.fetch(sb);
    // `a` is the oldest, but it is still in the set list; `b` was used long ago.
    keep.add("yt-a");
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(dir, "audio", "yt-a", "audio.json"), old, old);
    await utimes(join(dir, "audio", "yt-b", "audio.json"), old, old);
    await a.fetch(sc);
    expect((await readdir(join(dir, "audio"))).sort()).toEqual(["yt-a", "yt-c"]);
    expect(a.ready(sb)).toBe(false);
    expect(a.ready(sa)).toBe(true);
    // Reading a song makes it the newest.
    keep.clear();
    await utimes(join(dir, "audio", "yt-c", "audio.json"), old, old);
    await a.load(sc, "play_mix.pcm");
    await a.fetch(sd);
    expect((await readdir(join(dir, "audio"))).sort()).toEqual(["yt-c", "yt-d"]);
    expect((await stat(join(dir, "audio", "yt-d", "audio.json"))).isFile()).toBe(true);
  });
});
