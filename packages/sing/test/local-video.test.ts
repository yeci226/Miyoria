// `video_source = "local"`: Core downloads a song's video itself with yt-dlp (a fake spawner
// here, nothing is run and nothing goes to the network), into a temp dir next to the destination
// and then renamed into place; any failure but an abort falls back to the song worker.

import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadVideo,
  ensureVideo,
  localVideoFetcher,
  SingConfigSchema,
  type SingWorker,
  type SongMeta,
  songSourceUrl,
  type VideoProcess,
  type VideoSpawner,
  ytdlpArgs,
} from "../src/index.js";

/** A yt-dlp that does what the test says: `run` gets the args and the process. */
class FakeProcess extends EventEmitter implements VideoProcess {
  readonly stderr = new PassThrough();
  killedWith: NodeJS.Signals | null = null;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal ?? "SIGTERM";
    setImmediate(() => this.emit("close", null));
    return true;
  }

  close(code: number, stderr = ""): void {
    if (stderr) this.stderr.write(stderr);
    this.stderr.end();
    setImmediate(() => this.emit("close", code));
  }
}

type Behaviour = (args: readonly string[], process: FakeProcess) => void | Promise<void>;

function fakeSpawner(behaviour: Behaviour) {
  const calls: { command: string; args: readonly string[]; process: FakeProcess }[] = [];
  const spawn: VideoSpawner = (command, args) => {
    const process = new FakeProcess();
    calls.push({ command, args, process });
    void Promise.resolve(behaviour(args, process));
    return process;
  };
  return { spawn, calls };
}

/** Where yt-dlp was told to write (`--output <dir>/video.%(ext)s`). */
function outputDir(args: readonly string[]): string {
  const at = args.indexOf("--output");
  return dirname(args[at + 1] ?? "");
}

/** Writes `video.<ext>` like yt-dlp does, then exits 0. */
const writes =
  (ext = "mp4", body = "fake mp4 bytes"): Behaviour =>
  async (args, process) => {
    await writeFile(join(outputDir(args), `video.${ext}`), body);
    process.close(0);
  };

const options = (spawn: VideoSpawner, timeoutMs?: number) => ({
  ytdlpPath: "/opt/yt-dlp",
  maxHeight: 720,
  maxMb: 50,
  spawn,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

const LINK = "https://www.youtube.com/watch?v=abc123";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "local-video-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What is left in the song's dir: only the video, never a temp dir. */
function left(songDir: string): string[] {
  return existsSync(songDir) ? readdirSync(songDir) : [];
}

describe("ytdlpArgs", () => {
  it("picks the video like the worker and puts the link after --", () => {
    const args = ytdlpArgs("https://x.test/v", "/tmp/out", 1080, 300);
    expect(args).toContain("--no-playlist");
    expect(args[args.indexOf("--format") + 1]).toBe(
      "bv[height<=1080][vcodec^=avc1][filesize<?300M]/bv[height<=1080][filesize<?300M]/b[height<=1080][filesize<?300M]",
    );
    expect(args[args.indexOf("--max-filesize") + 1]).toBe("300M");
    expect(args[args.indexOf("--remux-video") + 1]).toBe("mp4");
    expect(args[args.indexOf("--output") + 1]).toBe(join("/tmp/out", "video.%(ext)s"));
    expect(args.slice(-2)).toEqual(["--", "https://x.test/v"]);
  });
});

describe("downloadVideo", () => {
  it("writes the video to the destination and removes its temp dir", async () => {
    const { spawn, calls } = fakeSpawner(writes());
    const dest = join(dir, "s1", "video.mp4");
    const bytes = await downloadVideo(LINK, dest, options(spawn), new AbortController().signal);
    expect(readFileSync(dest, "utf8")).toBe("fake mp4 bytes");
    expect(bytes).toBe("fake mp4 bytes".length);
    expect(left(join(dir, "s1"))).toEqual(["video.mp4"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/opt/yt-dlp");
    expect(calls[0]?.args.at(-1)).toBe(LINK);
    expect(calls[0]?.args[calls[0].args.indexOf("--format") + 1]).toContain("[height<=720]");
  });

  it("refuses a link that is not http(s), without starting anything", async () => {
    const { spawn, calls } = fakeSpawner(writes());
    for (const url of [
      "file:///etc/passwd",
      "--exec=rm -rf /",
      "javascript:alert(1)",
      "ftp://x/v",
    ]) {
      await expect(
        downloadVideo(
          url,
          join(dir, "s1", "video.mp4"),
          options(spawn),
          new AbortController().signal,
        ),
      ).rejects.toThrow(/not an http\(s\) link/);
    }
    expect(calls).toEqual([]);
    expect(left(join(dir, "s1"))).toEqual([]);
  });

  it("fails with the end of yt-dlp's stderr on a non-zero exit, and cleans up", async () => {
    const { spawn } = fakeSpawner((_args, p) => {
      p.close(1, `${"x".repeat(5000)}\nERROR: [youtube] abc123: Video unavailable\n`);
    });
    const dest = join(dir, "s1", "video.mp4");
    const error = await downloadVideo(
      LINK,
      dest,
      options(spawn),
      new AbortController().signal,
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^yt-dlp exited with 1: x+\nERROR: .*Video unavailable$/,
    );
    expect((error as Error).message.length).toBeLessThan(700);
    expect(left(join(dir, "s1"))).toEqual([]);
  });

  it("names the setting when yt-dlp is not there", async () => {
    const { spawn } = fakeSpawner((_args, p) => {
      setImmediate(() => {
        p.emit("error", Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" }));
        p.emit("close", -2);
      });
    });
    await expect(
      downloadVideo(
        LINK,
        join(dir, "s1", "video.mp4"),
        options(spawn),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/\/opt\/yt-dlp was not found: .*\[modules\.sing\] ytdlp_path/);
    expect(left(join(dir, "s1"))).toEqual([]);
  });

  it("fails when no mp4 came out", async () => {
    const { spawn } = fakeSpawner(writes("webm"));
    await expect(
      downloadVideo(
        LINK,
        join(dir, "s1", "video.mp4"),
        options(spawn),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/made no mp4/);
    expect(left(join(dir, "s1"))).toEqual([]);
  });

  it("kills yt-dlp when aborted", async () => {
    const { spawn, calls } = fakeSpawner(() => {}); // runs until killed
    const stop = new AbortController();
    const done = downloadVideo(LINK, join(dir, "s1", "video.mp4"), options(spawn), stop.signal);
    await new Promise((r) => setTimeout(r, 20));
    stop.abort(new Error("skipped"));
    await expect(done).rejects.toThrow("skipped");
    expect(calls[0]?.process.killedWith).toBe("SIGKILL");
    expect(left(join(dir, "s1"))).toEqual([]);
  });

  it("gives up after the timeout", async () => {
    const { spawn, calls } = fakeSpawner(() => {});
    await expect(
      downloadVideo(
        LINK,
        join(dir, "s1", "video.mp4"),
        options(spawn, 30),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/took longer than/);
    expect(calls[0]?.process.killedWith).toBe("SIGKILL");
    expect(left(join(dir, "s1"))).toEqual([]);
  });
});

function song(id: string, url: string | null): SongMeta {
  return {
    id,
    title: "Song MV",
    artist: null,
    duration_s: 1,
    lyrics: null,
    play: { sample_rate: 48_000, samples: 48_000 },
    pitch: {},
    timings: {},
    peak_vram_mb: null,
    has_video: true,
    video: { file: "video.mp4" },
    source: { kind: url === null ? "library" : "youtube", url },
  };
}

/** A song worker that only hands out videos (writes `from worker` at the destination). */
function videoWorker() {
  const downloads: { song: string; file: string; dest: string }[] = [];
  const worker = {
    async download(id: string, file: string, dest: string): Promise<void> {
      downloads.push({ song: id, file, dest });
      await writeFile(dest, "from worker").catch(() => undefined);
    },
  } as unknown as SingWorker;
  return { worker, downloads };
}

const local = (spawn: VideoSpawner) =>
  localVideoFetcher(
    SingConfigSchema.parse({ video_source: "local", ytdlp_path: "yt-dlp-test" }),
    spawn,
  );

describe("ensureVideo with video_source = local", () => {
  it("fetches the video locally and does not ask the worker", async () => {
    const { spawn, calls } = fakeSpawner(writes());
    const { worker, downloads } = videoWorker();
    const path = await ensureVideo(
      worker,
      dir,
      song("s-1", LINK),
      new AbortController().signal,
      local(spawn),
    );
    expect(path).toBe(join(dir, "s-1", "video.mp4"));
    expect(readFileSync(join(dir, "s-1", "video.mp4"), "utf8")).toBe("fake mp4 bytes");
    expect(calls.map((c) => [c.command, c.args.at(-1)])).toEqual([["yt-dlp-test", LINK]]);
    expect(downloads).toEqual([]);
  });

  it("falls back to the worker when the local download fails", async () => {
    const { spawn, calls } = fakeSpawner((_args, p) => p.close(1, "ERROR: HTTP Error 403"));
    const { worker, downloads } = videoWorker();
    const path = await ensureVideo(
      worker,
      dir,
      song("s-1", LINK),
      new AbortController().signal,
      local(spawn),
    );
    expect(calls).toHaveLength(1);
    expect(path).toBe(join(dir, "s-1", "video.mp4"));
    expect(downloads).toEqual([
      { song: "s-1", file: "video.mp4", dest: join(dir, "s-1", "video.mp4") },
    ]);
  });

  it("does not fall back when it was aborted", async () => {
    const { spawn, calls } = fakeSpawner(() => {});
    const { worker, downloads } = videoWorker();
    const stop = new AbortController();
    const done = ensureVideo(worker, dir, song("s-1", LINK), stop.signal, local(spawn));
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    expect(await done).toBeNull();
    expect(calls).toHaveLength(1);
    expect(downloads).toEqual([]);
    expect(left(join(dir, "s-1"))).toEqual([]);
  });

  it("asks the worker for a song without an http(s) link, starting nothing", async () => {
    const { spawn, calls } = fakeSpawner(writes());
    const { worker, downloads } = videoWorker();
    await ensureVideo(worker, dir, song("s-1", null), new AbortController().signal, local(spawn));
    await ensureVideo(
      worker,
      dir,
      song("s-2", "file:///etc/passwd"),
      new AbortController().signal,
      local(spawn),
    );
    const older = { ...song("s-3", LINK) };
    delete older.source; // stored by an older Core
    await ensureVideo(worker, dir, older, new AbortController().signal, local(spawn));
    expect(calls).toEqual([]);
    expect(downloads.map((d) => d.song)).toEqual(["s-1", "s-2", "s-3"]);
  });

  it("starts nothing for a song the worker has no video for", async () => {
    const { spawn, calls } = fakeSpawner(writes());
    const { worker, downloads } = videoWorker();
    const audioOnly = { ...song("s-1", LINK), has_video: false, video: null };
    expect(
      await ensureVideo(worker, dir, audioOnly, new AbortController().signal, local(spawn)),
    ).toBeNull();
    expect(calls).toEqual([]);
    expect(downloads).toEqual([]);
  });

  it("uses a video already on disk as it is", async () => {
    const { spawn, calls } = fakeSpawner(writes());
    const { worker, downloads } = videoWorker();
    const first = await ensureVideo(
      worker,
      dir,
      song("s-1", LINK),
      new AbortController().signal,
      local(spawn),
    );
    const again = await ensureVideo(
      worker,
      dir,
      song("s-1", LINK),
      new AbortController().signal,
      local(spawn),
    );
    expect(again).toBe(first);
    expect(calls).toHaveLength(1);
    expect(downloads).toEqual([]);
  });
});

describe("localVideoFetcher", () => {
  it("is off by default: video_source = worker never starts yt-dlp", () => {
    const cfg = SingConfigSchema.parse({});
    expect(cfg).toMatchObject({
      video_source: "worker",
      ytdlp_path: "yt-dlp",
      video_max_height: 1080,
      video_max_mb: 300,
    });
    expect(localVideoFetcher(cfg, fakeSpawner(writes()).spawn)).toBeNull();
    expect(typeof localVideoFetcher({ ...cfg, video_source: "local" })).toBe("function");
  });

  it("reads the song's link only when it is http(s)", () => {
    expect(songSourceUrl(song("s", LINK))).toBe(LINK);
    expect(songSourceUrl(song("s", "http://b23.tv/x"))).toBe("http://b23.tv/x");
    expect(songSourceUrl(song("s", "file:///etc/passwd"))).toBeNull();
    expect(songSourceUrl(song("s", null))).toBeNull();
  });
});
