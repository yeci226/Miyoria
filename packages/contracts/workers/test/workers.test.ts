// One real example per JSON body of the workers: it parses, and written out and read again it is
// the same. The examples are what the Python workers and the fake worker answer (workers/*/server.py,
// workers/fake/fake_server.py) and what the clients send. Then the leniency the clients rely on.

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  WORKERS_ASR_FORM_FIELDS,
  WORKERS_SAMPLE_RATE_HEADER,
  WORKERS_TURN_SAMPLE_RATE,
  WORKERS_VAD_FRAME_SAMPLES,
  WorkersAsrHealthSchema,
  WorkersAsrReplySchema,
  WorkersBusySchema,
  WorkersErrorSchema,
  WorkersHealthSchema,
  WorkersLyricsHealthSchema,
  WorkersLyricsHintsSchema,
  WorkersLyricsReplySchema,
  WorkersOffloadReplySchema,
  WorkersOffloadRequestSchema,
  WorkersReloadReplySchema,
  WorkersSingGpuContextSchema,
  WorkersSingHealthSchema,
  WorkersSingJobReplySchema,
  WorkersSingJobRequestSchema,
  WorkersSingJobSchema,
  WorkersSingLibrarySchema,
  WorkersSingLyricsReplySchema,
  WorkersSingLyricsRequestSchema,
  WorkersSingOkSchema,
  WorkersSingPruneRequestSchema,
  WorkersSingSongMetaSchema,
  WorkersSingSongsReplySchema,
  WorkersTtsHealthSchema,
  WorkersTtsOffloadRequestSchema,
  WorkersTtsRequestSchema,
  WorkersTtsVoicesSchema,
  WorkersTurnHealthSchema,
  WorkersTurnReplySchema,
} from "../src/index.js";

/** `parse(example)`, then through JSON and `parse` again: the same. */
function roundTrip<S extends z.ZodType>(schema: S, example: unknown): z.output<S> {
  const once = schema.parse(example);
  const twice = schema.parse(JSON.parse(JSON.stringify(once)));
  expect(twice).toEqual(once);
  return once;
}

const song = {
  id: "yt-abc123-k0",
  title: "櫻ノ詩",
  artist: "Someone",
  duration_s: 212.4,
  source: { key: "yt-abc123", kind: "youtube", title: "櫻ノ詩", url: "https://youtu.be/abc123" },
  pitch: { octave_shift: 0, auto_key: -2, vocal_shift: -2 },
  backing: "keep",
  lyrics: {
    provider: "lrclib",
    synced: true,
    lines: [
      { t: 12.5, text: "春の風" },
      { t: 15.1, text: "舞い散る" },
    ],
    plain: null,
  },
  beats: { bpm: 128, times: [0.5, 0.97] },
  has_video: true,
  video: { file: "video.mp4" },
  play: { sample_rate: 48000, samples: 10195200, format: "s16le", channels: 1 },
  timings: { separate: 31.2, convert: 88.4 },
  peak_vram_mb: 6120,
  created_at: "2026-11-12T10:00:00+00:00",
};

const gpu = {
  policy: "auto",
  stage: "convert",
  mode: "share",
  code: "fits",
  reason: "room for both",
  free_mb: 5200,
  total_mb: 12282,
  need_mb: 3100,
  headroom_mb: 800,
  speech_loaded: true,
  people: true,
  urgent: false,
  step_s: 0.4,
  baseline_s: 0.38,
  spilling: false,
  spills: 0,
  steps: null,
  waited_s: 0,
  silenced_s: 0,
  silence_est_s: null,
  silence_max_s: 20,
};

describe("common", () => {
  it("reads a health answer, an error and the busy count", () => {
    expect(roundTrip(WorkersHealthSchema, { status: "ok", model: "fake" }).status).toBe("ok");
    expect(roundTrip(WorkersErrorSchema, { error: "offloaded" })).toEqual({ error: "offloaded" });
    expect(roundTrip(WorkersBusySchema, { busy: 2 })).toEqual({ busy: 2 });
  });

  it("reads the answers to offload and reload", () => {
    const body = { reason: "sing", max_s: 900 };
    expect(roundTrip(WorkersOffloadRequestSchema, body)).toEqual(body);
    expect(roundTrip(WorkersOffloadRequestSchema, {})).toEqual({});
    const offloaded = {
      state: "offloaded",
      offload_ms: 1840,
      vram_before_mb: 4300,
      vram_after_mb: 0,
      device_used_before_mb: 9100,
      device_used_after_mb: 4700,
      released_mb: 4400,
    };
    expect(roundTrip(WorkersOffloadReplySchema, offloaded)).toEqual(offloaded);
    const ready = { state: "ready", reload_ms: 12040, vram_mb: 4300, device_total_mb: 12282 };
    expect(roundTrip(WorkersReloadReplySchema, ready)).toEqual(ready);
    expect(
      roundTrip(WorkersReloadReplySchema, { state: "ready", reload_ms: 0, already: true }).already,
    ).toBe(true);
  });
});

describe("asr", () => {
  it("reads a reply with everything (SenseVoice, the fake worker)", () => {
    const reply = {
      text: "早安,這是假的辨識結果。",
      language: "zh",
      emotion: "neutral",
      audio_events: [],
      duration_ms: 1234,
    };
    expect(roundTrip(WorkersAsrReplySchema, reply)).toEqual(reply);
  });

  it("reads a reply with only the text (Qwen3-ASR)", () => {
    expect(roundTrip(WorkersAsrReplySchema, { text: "早安", duration_ms: 900 })).toEqual({
      text: "早安",
      language: null,
      emotion: null,
      audio_events: [],
      duration_ms: 900,
    });
  });

  it("reads the health answer", () => {
    const health = {
      status: "ok",
      model: "Qwen/Qwen3-ASR-0.6B",
      device: "cuda:0",
      backend: "qwen3",
      offloaded: false,
      loading: false,
      released_mb: null,
      vram_allocated_mb: 1500,
      device_total_mb: 12282,
      device_used_mb: 7000,
      device_free_mb: 5282,
    };
    expect(roundTrip(WorkersAsrHealthSchema, health)).toEqual(health);
    const away = {
      ...health,
      offloaded: true,
      released_mb: 1500,
      since: 1.7e9,
      reason: "sing",
      reload_at: 1.7e9 + 900,
    };
    expect(roundTrip(WorkersAsrHealthSchema, away)).toEqual(away);
  });

  it("names the form fields", () => {
    expect(Object.values(WORKERS_ASR_FORM_FIELDS)).toEqual([
      "audio",
      "language",
      "prompt",
      "priority",
    ]);
  });
});

describe("tts", () => {
  it("reads the request the client sends", () => {
    const request = {
      text: "哼,才不是在等你呢。",
      language: "Chinese",
      emotion: "annoyed",
      instruct: "不耐煩、拖長音",
      voice: "deepseek-chan",
      priority: "ahead",
    };
    expect(roundTrip(WorkersTtsRequestSchema, request)).toEqual(request);
    expect(roundTrip(WorkersTtsRequestSchema, { text: "嗨", language: null })).toEqual({
      text: "嗨",
      language: null,
    });
  });

  it("reads the offload request with the drain", () => {
    const body = { reason: "sing", max_s: 900, drain_s: 15 };
    expect(roundTrip(WorkersTtsOffloadRequestSchema, body)).toEqual(body);
  });

  it("reads the voices", () => {
    const voices = {
      mode: "clone",
      default: "deepseek-chan",
      clone_mode: "icl",
      voice_bank: true,
      voices: [
        {
          name: "deepseek-chan",
          ref_text: "你好",
          x_vector_only: false,
          references: ["ref", "bank/ja/happy"],
        },
        { name: "plain", ref_text: null, x_vector_only: true, references: ["ref"] },
      ],
    };
    expect(roundTrip(WorkersTtsVoicesSchema, voices)).toEqual(voices);
  });

  it("reads the health answer, loaded and given up", () => {
    const loaded = {
      offloaded: false,
      status: "ok",
      model: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
      device: "cuda:0",
      mode: "clone",
      backend: "faster",
      sample_rate: 24000,
      streaming: true,
      chunk_size: 4,
      stream_probe: [],
      voices: ["deepseek-chan"],
      instruct_supported: false,
      clone_mode: "icl",
      voice_bank: true,
      released_mb: null,
      engine_pid: null,
      vram_allocated_mb: 5100,
    };
    expect(roundTrip(WorkersTtsHealthSchema, loaded)).toEqual(loaded);
    const away = {
      status: "ok",
      offloaded: true,
      model: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
      since: 1.7e9,
      reason: "sing",
      reload_at: null,
      loading: false,
      released_mb: 5100,
      vram_allocated_mb: null,
    };
    expect(roundTrip(WorkersTtsHealthSchema, away)).toEqual(away);
  });
});

describe("turn", () => {
  it("reads the answer and the health", () => {
    const reply = { complete: true, probability: 0.9, inference_ms: 12.5 };
    expect(roundTrip(WorkersTurnReplySchema, reply)).toEqual(reply);
    const health = {
      status: "ok",
      smart_turn: true,
      silero: false,
      threshold: 0.5,
      errors: { silero: "model file not found" },
    };
    expect(roundTrip(WorkersTurnHealthSchema, health)).toEqual(health);
  });

  it("does not fail on an inference time it does not understand", () => {
    expect(
      WorkersTurnReplySchema.parse({ complete: false, probability: 0.1, inference_ms: "x" }),
    ).toEqual({
      complete: false,
      probability: 0.1,
    });
  });

  it("refuses an answer without its two fields", () => {
    expect(WorkersTurnReplySchema.safeParse({ complete: true }).success).toBe(false);
    expect(WorkersTurnReplySchema.safeParse({ complete: "yes", probability: 1 }).success).toBe(
      false,
    );
  });

  it("names the protocol constants", () => {
    expect(WORKERS_SAMPLE_RATE_HEADER).toBe("x-sample-rate");
    expect(WORKERS_TURN_SAMPLE_RATE).toBe(16_000);
    expect(WORKERS_VAD_FRAME_SAMPLES).toBe(512);
  });
});

describe("lyrics", () => {
  it("reads the hints, the reply and the health", () => {
    const hints = {
      key: "yt-abc123",
      raw_title: "【MV】櫻ノ詩 / Someone",
      title: "櫻ノ詩",
      artist: "Someone",
      uploader: "Someone Official",
      tags: ["jpop", "mv"],
      duration: 212.4,
      url: "https://youtu.be/abc123",
    };
    expect(roundTrip(WorkersLyricsHintsSchema, hints)).toEqual(hints);
    const found = {
      found: true,
      result: {
        provider: "lrclib",
        synced: true,
        lrc: "[00:12.50]春の風\n[00:15.10]舞い散る",
        plain: null,
        track: "櫻ノ詩",
        artist: "Someone",
        how: "metadata",
        confidence: 0.94,
        matched: { query: "Someone 櫻ノ詩", duration_s: 211 },
        checks: { title: 1, artist: 1, duration_diff_s: 1.4, fit: null },
        tried: 2,
        llm: null,
      },
    };
    expect(roundTrip(WorkersLyricsReplySchema, found)).toEqual(found);
    expect(roundTrip(WorkersLyricsReplySchema, { found: false, result: null }).result).toBeNull();
    expect(roundTrip(WorkersLyricsHealthSchema, { ok: true })).toEqual({ ok: true });
  });
});

describe("sing", () => {
  it("reads the job request", () => {
    expect(
      roundTrip(WorkersSingJobRequestSchema, {
        query: "櫻ノ詩",
        key: -2,
        backing: "drop",
        exclusive_ack: true,
      }),
    ).toEqual({
      query: "櫻ノ詩",
      key: -2,
      backing: "drop",
      force: false,
      exclusive_ack: true,
      purpose: "cover",
      karaoke_video: true,
    });
    expect(WorkersSingJobRequestSchema.parse({ url: "https://youtu.be/abc123" })).toMatchObject({
      key: 0,
      backing: "keep",
      force: false,
      exclusive_ack: false,
      purpose: "cover",
    });
    expect(
      WorkersSingJobRequestSchema.parse({ url: "https://youtu.be/abc123", purpose: "karaoke" })
        .purpose,
    ).toBe("karaoke");
    expect(WorkersSingJobRequestSchema.safeParse({ query: "x", purpose: "mix" }).success).toBe(
      false,
    );
    expect(WorkersSingJobRequestSchema.safeParse({ query: "x", backing: "mute" }).success).toBe(
      false,
    );
    expect(WorkersSingJobRequestSchema.safeParse({ query: "x", key: 13 }).success).toBe(false);
  });

  it("reads the GPU context", () => {
    const context = { in_voice: true, listeners: 2, live: false, urgent: ["a1b2c3"] };
    expect(roundTrip(WorkersSingGpuContextSchema, context)).toEqual(context);
    expect(WorkersSingGpuContextSchema.parse({})).toEqual({
      in_voice: false,
      listeners: 0,
      live: false,
      urgent: [],
    });
    expect(roundTrip(WorkersSingOkSchema, { ok: true })).toEqual({ ok: true });
  });

  it("reads a finished song and its link, without the keys nobody reads", () => {
    const meta = roundTrip(WorkersSingSongMetaSchema, song);
    expect(meta).toMatchObject({
      id: "yt-abc123-k0",
      title: "櫻ノ詩",
      backing: "keep",
      has_video: true,
      video: { file: "video.mp4" },
      beats: { bpm: 128, times: [0.5, 0.97] },
      play: { sample_rate: 48000, samples: 10195200 },
    });
    expect(meta.source).toEqual({ kind: "youtube", url: "https://youtu.be/abc123" });
    expect(meta.lyrics).toEqual({ synced: true, lines: song.lyrics.lines });
  });

  it("reads a song of an older worker: what is missing falls back", () => {
    expect(
      WorkersSingSongMetaSchema.parse({ id: "s", play: { sample_rate: 48000, samples: null } }),
    ).toEqual({
      id: "s",
      title: "",
      artist: null,
      duration_s: null,
      lyrics: null,
      play: { sample_rate: 48000, samples: null },
      pitch: {},
      timings: {},
      peak_vram_mb: null,
      has_video: false,
      video: null,
    });
    expect(
      WorkersSingSongMetaSchema.parse({ ...song, beats: "x", lyrics: 3, title: 5, source: 7 }),
    ).toMatchObject({
      title: "",
      lyrics: null,
      beats: null,
      source: null,
    });
    expect(
      WorkersSingSongMetaSchema.parse({ ...song, source: { kind: "library", url: 9 } }).source,
    ).toEqual({ kind: "library", url: null });
    expect(WorkersSingSongMetaSchema.safeParse({ id: "s" }).success).toBe(false);
  });

  it("reads a job in every state, with and without the GPU", () => {
    const running = {
      id: "a1b2c3d4e5f6",
      state: "running",
      stage: "convert",
      progress: 0.42,
      error: null,
      song_id: null,
      source: { key: "yt-abc123", kind: "youtube", title: "櫻ノ詩", artist: "Someone" },
      cached: false,
      request: { query: "櫻ノ詩", key: 0, backing: "keep", force: false, exclusive_ack: false },
      position: null,
      created_at: "2026-11-12T10:00:00+00:00",
      started_at: "2026-11-12T10:00:02+00:00",
      finished_at: null,
      song: null,
      video: null,
      exclusive: "shared",
      exclusive_info: { state: "shared", offloaded: [], errors: [] },
      yielded: null,
      gpu,
    };
    const job = roundTrip(WorkersSingJobSchema, running);
    expect(job).toMatchObject({
      state: "running",
      progress: 0.42,
      source: { title: "櫻ノ詩", artist: "Someone" },
      exclusive: "shared",
      gpu: { mode: "share", reason: "room for both", silence_max_s: 20 },
    });
    expect(job.gpu).not.toHaveProperty("headroom_mb");
    const done = roundTrip(WorkersSingJobReplySchema, {
      job: {
        ...running,
        state: "done",
        stage: "done",
        progress: 1,
        song_id: song.id,
        song,
        gpu: null,
      },
    });
    expect(done.job.song?.title).toBe("櫻ノ詩");
    expect(done.job.gpu).toBeNull();
  });

  it("reads a job of an older worker, and refuses one that is no job", () => {
    expect(WorkersSingJobSchema.parse({ id: "j", state: "queued" })).toEqual({
      id: "j",
      state: "queued",
      stage: "",
      progress: 0,
      error: null,
      song_id: null,
      cached: false,
      position: null,
      source: null,
      song: null,
      exclusive: null,
      gpu: null,
    });
    expect(
      WorkersSingJobSchema.parse({ id: "j", state: "queued", exclusive: "later", gpu: 5 }),
    ).toMatchObject({
      exclusive: null,
      gpu: null,
    });
    expect(WorkersSingJobSchema.safeParse({ id: "j", state: "sleeping" }).success).toBe(false);
    expect(WorkersSingJobReplySchema.safeParse({}).success).toBe(false);
  });

  it("reads the song list, the lyrics, the library and the prune request", () => {
    expect(roundTrip(WorkersSingSongsReplySchema, { songs: [song] }).songs).toHaveLength(1);
    expect(roundTrip(WorkersSingLyricsRequestSchema, { title: "櫻ノ詩", fresh: true })).toEqual({
      title: "櫻ノ詩",
      fresh: true,
    });
    const found = {
      found: true,
      previous: { provider: "lrclib", track: "櫻ノ詩" },
      lyrics: { provider: "netease", synced: true },
      lines: 31,
    };
    expect(roundTrip(WorkersSingLyricsReplySchema, found)).toEqual(found);
    const kept = { found: false, kept: true, lyrics: { provider: "lrclib", synced: true } };
    expect(roundTrip(WorkersSingLyricsReplySchema, kept)).toEqual(kept);
    const library = {
      entries: [{ path: "jp/櫻ノ詩.flac", title: "櫻ノ詩", artist: null, split: false }],
    };
    expect(roundTrip(WorkersSingLibrarySchema, library)).toEqual(library);
    expect(roundTrip(WorkersSingPruneRequestSchema, { dry_run: true })).toEqual({ dry_run: true });
  });

  it("reads the health answer", () => {
    const health = {
      status: "ok",
      model: "rvc",
      device: "cuda:0",
      backend: "rvc",
      busy: true,
      queued: 1,
      vram_allocated_mb: 3100,
      gpu: {
        policy: "auto",
        policy_source: "default",
        cuda: true,
        total_mb: 12282,
        free_mb: 5200,
        headroom_mb: 800,
        audience: { in_voice: true, listeners: 2, live: false, age_s: 1.2, fresh: true },
        learned: {
          device: "cuda:0",
          stages: {},
          headroom_mb: null,
          freed_mb: null,
          reload_s: null,
          spills: 0,
        },
        job: gpu,
      },
    };
    const parsed = roundTrip(WorkersSingHealthSchema, health);
    expect(parsed.status).toBe("ok");
    expect(parsed.gpu?.job?.mode).toBe("share");
  });
});
