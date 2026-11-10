// The song's video while she sings: the cue on the bus → `song_video` messages (Forwarder), the
// scene director's `sing` scene and the way back, and the Stage side with a fake OBS (file,
// mute, timing, the scene fallback, drift, paths it refuses, OBS away).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  customEvent,
  type JsonObject,
  parseSongCue,
  SONG_TOPIC,
  SPEECH_PAUSE_TOPIC,
  systemClock,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CoreMessage,
  Forwarder,
  ObsConfigSchema,
  OverlayHub,
  parseCoreMessage,
  SceneDirector,
  SceneRoles,
  ScenesConfigSchema,
  SongVideo,
  songVideoFile,
} from "../src/index.js";
import { delay, FakeObs, tempDir, waitUntil } from "./common.js";

const SOURCE = "Miyoria 歌曲影片";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

/** A song cache with one video; returns the dir and the video's path. */
function cache(): { dir: string; video: string } {
  const dir = tempDir();
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "yt-abc"));
  const video = join(dir, "yt-abc", "video.mp4");
  writeFileSync(video, "mp4");
  writeFileSync(join(dir, "yt-abc", "meta.json"), "{}");
  return { dir, video };
}

function rig(opts: { latencyMs?: number; resyncMs?: number; obs?: FakeObs | null } = {}) {
  const { dir, video } = cache();
  const obs = opts.obs === undefined ? new FakeObs("聊天") : opts.obs;
  if (obs) {
    obs.items.set("唱歌", [{ id: 7, source: SOURCE, enabled: true }]);
    obs.items.set("聊天", [{ id: 1, source: "VTS", enabled: true }]);
  }
  const config = ObsConfigSchema.parse({
    song_video_dir: dir,
    song_video_resync_ms: opts.resyncMs ?? 0,
  });
  const sv = new SongVideo({
    obs: () => obs,
    currentScene: () => obs?.state.scene ?? null,
    config,
    latencyMs: opts.latencyMs ?? 60,
    clock: systemClock,
  });
  const media = () =>
    (obs?.state.calls ?? []).filter((c) => c.startsWith("media") || /^(show|hide)/.test(c));
  return { sv, obs, dir, video, media };
}

describe("song video on the stage", () => {
  it("plays muted in the sing scene, starting when viewers hear the song, and clears after", async () => {
    const { sv, obs, video, media } = rig({ latencyMs: 80 });
    const t0 = Date.now();
    sv.play({ song: "yt-abc", path: video, offset_ms: 0, scene: "唱歌" });
    await waitUntil(() => media().includes(`media ${SOURCE} restart`), "restart");
    expect(Date.now() - t0, "waits latency_ms like her mouth").toBeGreaterThanOrEqual(75);
    expect(media()).toEqual([`media ${SOURCE} = ${video}`, `media ${SOURCE} restart`]);
    expect(obs?.media.get(SOURCE)?.muted).toBe(true);
    expect(sv.playing()).toBe("yt-abc");

    sv.stop("other song");
    await delay(150);
    expect(sv.playing(), "a stop for another song is ignored").toBe("yt-abc");
    sv.stop("yt-abc");
    await delay(20);
    expect(sv.playing(), "the end is also latency_ms late").toBe("yt-abc");
    await waitUntil(() => sv.playing() === null, "stopped");
    await sv.idle();
    expect(media().slice(2)).toEqual([`media ${SOURCE} stop`, `media ${SOURCE} = `]);
  });

  it("without a sing scene uses the current scene, showing a hidden item for the song", async () => {
    const { sv, obs, video, media } = rig({ latencyMs: 0 });
    obs?.items.set("聊天", [{ id: 3, source: SOURCE, enabled: false }]);
    sv.play({ song: "yt-abc", path: video });
    await waitUntil(() => media().includes(`media ${SOURCE} restart`), "restart");
    expect(media()).toContain("show 聊天#3");
    sv.stop("yt-abc");
    await waitUntil(() => media().includes("hide 聊天#3"), "hidden again");
  });

  it("finds the video inside a scene nested in the sing scene (a frame around it)", async () => {
    const { sv, obs, video, media } = rig({ latencyMs: 0 });
    obs?.items.set("唱歌", [{ id: 2, source: "唱歌 · 影片", enabled: true }]);
    obs?.items.set("唱歌 · 影片", [{ id: 5, source: SOURCE, enabled: false }]);
    sv.play({ song: "yt-abc", path: video, scene: "唱歌" });
    await waitUntil(() => media().includes(`media ${SOURCE} restart`), "restart");
    expect(media()).toContain("show 唱歌 · 影片#5");
    sv.stop("yt-abc");
    await waitUntil(() => media().includes("hide 唱歌 · 影片#5"), "hidden again");
  });

  it("does nothing when the scene has no video source", async () => {
    const { sv, video, media } = rig({ latencyMs: 0 });
    sv.play({ song: "yt-abc", path: video });
    await delay(50);
    await sv.idle();
    expect(media()).toEqual([]);
    expect(sv.playing()).toBeNull();
  });

  it("refuses paths outside the song cache and non-videos", async () => {
    const { sv, dir, media } = rig({ latencyMs: 0 });
    const outside = join(tempDir(), "video.mp4");
    writeFileSync(outside, "x");
    for (const path of [
      outside,
      join(dir, "yt-abc", "meta.json"),
      join(dir, "nope", "video.mp4"),
    ]) {
      sv.play({ song: "yt-abc", path, scene: "唱歌" });
      await sv.idle();
    }
    sv.play({ song: "yt-abc", scene: "唱歌" });
    await sv.idle();
    expect(media()).toEqual([]);
    expect(await songVideoFile(dir, "relative/video.mp4")).toBeNull();
    expect(await songVideoFile(dir, join(dir, "yt-abc", "..", "..", "video.mp4"))).toBeNull();
  });

  it("never throws while OBS is away or refuses", async () => {
    const away = rig({ obs: null, latencyMs: 0 });
    away.sv.play({ song: "yt-abc", path: away.video, scene: "唱歌" });
    away.sv.stop("yt-abc");
    await delay(20);
    await away.sv.idle();

    const { sv, obs, video } = rig({ latencyMs: 0 });
    if (obs) obs.mediaAction = async () => Promise.reject(new Error("OBS said no"));
    sv.play({ song: "yt-abc", path: video, scene: "Missing scene" });
    sv.play({ song: "yt-abc", path: video, scene: "唱歌" });
    await sv.idle();
    sv.close();
    await sv.idle();
  });

  it("seeks a video that drifted, and starts a late one where the song is", async () => {
    const { sv, obs, video, media } = rig({ latencyMs: 0, resyncMs: 200 });
    if (!obs) throw new Error("no obs");
    obs.cursorSkew = -900; // OBS took long to open the file
    sv.play({ song: "yt-abc", path: video, scene: "唱歌" });
    await waitUntil(() => media().some((c) => c.includes(" seek ")), "resync");
    const seek = Number(
      media()
        .find((c) => c.includes(" seek "))
        ?.split(" seek ")[1],
    );
    expect(seek).toBeGreaterThan(1_400);
    expect(seek).toBeLessThan(2_000);

    // A node that connected 30 s into the song: started at once, then seeked to ~30 s.
    sv.play({ song: "yt-abc", path: video, scene: "唱歌", offset_ms: 30_000 });
    await waitUntil(() => media().filter((c) => c.includes(" seek ")).length === 2, "late seek");
    const late = Number(
      media()
        .filter((c) => c.includes(" seek "))
        .at(-1)
        ?.split(" seek ")[1],
    );
    expect(late).toBeGreaterThanOrEqual(30_000);
    expect(late).toBeLessThan(31_000);
    sv.close();
    await sv.idle();
  });
});

describe("song cues to stage messages", () => {
  const started = (extra: object = {}) =>
    customEvent(SONG_TOPIC, { state: "started", song: "yt-abc", title: "T", ...extra });

  it("sends play with the sing scene and stop at the end; resumes for a new node", () => {
    let now = 1_000;
    const f = new Forwarder(false, { singScene: () => "唱歌", now: () => now });
    const out = f.onEvent(started({ video: "C:\\songs\\yt-abc\\video.mp4", offset_ms: 0 }));
    expect(out).toStrictEqual([
      { type: "speaking", state: "started" },
      {
        type: "song_video",
        action: "play",
        song: "yt-abc",
        path: "C:\\songs\\yt-abc\\video.mp4",
        offset_ms: 0,
        scene: "唱歌",
      },
    ]);
    now += 42_000;
    expect(f.resumeSongVideo()).toMatchObject({ action: "play", offset_ms: 42_000 });
    const end = f.onEvent(
      customEvent(SONG_TOPIC, { state: "ended", song: "yt-abc", outcome: "finished" }),
    );
    expect(end.at(-1)).toStrictEqual({ type: "song_video", action: "stop", song: "yt-abc" });
    expect(f.resumeSongVideo()).toBeNull();
  });

  it("a speech pause shows 準備歌曲中… on the overlay until it ends", () => {
    const f = new Forwarder(false);
    const pause = (payload: JsonObject) => f.onEvent(customEvent(SPEECH_PAUSE_TOPIC, payload));
    expect(pause({ paused: true, reason: "song" })).toStrictEqual([
      { type: "notice", text: "準備歌曲中…" },
    ]);
    expect(pause({ paused: false, reason: null })).toStrictEqual([{ type: "notice", text: "" }]);
    expect(pause({})).toStrictEqual([]);
    expect(parseCoreMessage({ type: "notice", text: "準備歌曲中…" })).toStrictEqual({
      type: "notice",
      text: "準備歌曲中…",
    });
    const hub = new OverlayHub();
    hub.notice("準備歌曲中…");
    expect(hub.initial()).toContain('{"type":"notice","text":"準備歌曲中…"}');
    hub.notice("");
    expect(hub.initial().some((m) => m.includes("notice"))).toBe(false);
  });

  it("sends the beat at the start, stops it at the end and resumes it for a new node", () => {
    let now = 5_000;
    const f = new Forwarder(false, { now: () => now });
    const beats = { bpm: 120, times_ms: [500, 1000, 1500] };
    const out = f.onEvent(started({ beats }));
    expect(out).toStrictEqual([
      { type: "speaking", state: "started" },
      { type: "beat", song: "yt-abc", bpm: 120, times_ms: [500, 1000, 1500], offset_ms: 0 },
    ]);
    now += 1_200;
    expect(f.resumeBeat()).toMatchObject({ type: "beat", offset_ms: 1_200 });
    const end = f.onEvent(
      customEvent(SONG_TOPIC, { state: "ended", song: "yt-abc", outcome: "finished" }),
    );
    expect(end.at(-1)).toStrictEqual({
      type: "beat",
      song: "yt-abc",
      bpm: 0,
      times_ms: [],
      offset_ms: 0,
    });
    expect(f.resumeBeat()).toBeNull();
    expect(
      parseCoreMessage({ type: "beat", song: "s", bpm: 98.5, times_ms: [1, 2], offset_ms: 3 }),
    ).toStrictEqual({ type: "beat", song: "s", bpm: 98.5, times_ms: [1, 2], offset_ms: 3 });
  });

  it("parses beats on a cue: sorted, finite and capped", () => {
    const cue = parseSongCue({
      state: "started",
      song: "s",
      title: "t",
      beats: { bpm: 100, times_ms: [600, 100, 600, -5, "x", 1200.4] },
    });
    expect(cue).toMatchObject({ beats: { bpm: 100, times_ms: [600, 1200] } });
    expect(
      parseSongCue({ state: "started", song: "s", title: "t", beats: { bpm: 0, times_ms: [1] } }),
    ).not.toHaveProperty("beats");
  });

  it("songs without a video send no video messages", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(started()).map((m: CoreMessage) => m.type)).toEqual(["speaking"]);
    const end = f.onEvent(
      customEvent(SONG_TOPIC, { state: "ended", song: "yt-abc", outcome: "x" }),
    );
    expect(end.map((m) => m.type)).toEqual(["speaking", "subtitle"]);
  });

  it("parses the cue and the wire message", () => {
    expect(parseSongCue({ state: "started", song: "s", title: "t", video: "/v.mp4" })).toEqual({
      state: "started",
      song: "s",
      title: "t",
      video: "/v.mp4",
      offset_ms: 0,
    });
    expect(parseSongCue({ state: "started", song: "s", title: "t", video: 3 })).toEqual({
      state: "started",
      song: "s",
      title: "t",
    });
    expect(
      parseCoreMessage({
        type: "song_video",
        action: "play",
        song: "s",
        path: "/v.mp4",
        scene: " ",
      }),
    ).toStrictEqual({ type: "song_video", action: "play", song: "s", path: "/v.mp4" });
    expect(parseCoreMessage({ type: "song_video", action: "stop", song: "s" })).toStrictEqual({
      type: "song_video",
      action: "stop",
      song: "s",
    });
    expect(() => parseCoreMessage({ type: "song_video", action: "loop", song: "s" })).toThrow();
  });
});

describe("the director's sing scene", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function director(scenes: string[], roles: Record<string, string> = {}) {
    const config = ScenesConfigSchema.parse({ roles, classify: false });
    const r = new SceneRoles(config, {
      settings: () => undefined,
      router: () => undefined,
      signal: new AbortController().signal,
    });
    r.observe(scenes);
    await r.idle();
    const switches: string[] = [];
    let d: SceneDirector;
    const show = (scene: string) => d.onStatus({ obs: true, streaming: false, scene });
    d = new SceneDirector({
      config,
      roles: r,
      switchRole: async (role) => {
        const scene = r.resolve(role);
        if (scene === null) return false;
        switches.push(`role:${role}`);
        show(scene);
        return true;
      },
      switchScene: async (name) => {
        switches.push(`scene:${name}`);
        show(name);
        return true;
      },
    });
    show(scenes[0] ?? "");
    return { d, switches, show };
  }

  it("goes to the sing scene at once and back to the scene before it", async () => {
    const t = await director(["Talk", "Game", "Camera", "Karaoke"], { sing: "Karaoke" });
    t.show("Camera"); // the owner's own scene, no role
    t.d.onSong(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.switches, "urgent: no debounce, no manual hold").toEqual(["role:sing"]);
    await vi.advanceTimersByTimeAsync(180_000);
    t.d.onSong(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.switches).toEqual(["role:sing", "scene:Camera"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.switches).toHaveLength(2);
    t.d.stop();
  });

  it("after a song during which a game started, goes where she is now", async () => {
    const t = await director(["Talk", "Game", "Sing MV"]);
    t.d.onSong(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.switches, "found by keyword").toEqual(["role:sing"]);
    t.d.onGame(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.switches, "the song keeps the scene").toEqual(["role:sing"]);
    t.d.onSong(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.switches).toEqual(["role:sing", "role:game"]);
    t.d.stop();
  });

  it("leaves the scene alone without a sing scene, or when someone moved away", async () => {
    const none = await director(["Talk", "Game", "Camera"]);
    none.show("Camera");
    none.d.onSong(true);
    await vi.advanceTimersByTimeAsync(200_000);
    none.d.onSong(false);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(none.switches).toEqual([]);
    none.d.stop();

    const moved = await director(["Talk", "Game", "Karaoke"], { sing: "Karaoke" });
    moved.d.onSong(true);
    await vi.advanceTimersByTimeAsync(10);
    moved.show("Game"); // the owner switched during the song
    moved.d.onSong(false);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(moved.switches).toEqual(["role:sing"]);
    moved.d.stop();
  });
});
