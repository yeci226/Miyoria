// Provider and module tests against in-process `node:http` mock servers.

import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { errorMessage, sleep } from "@miyoria/runtime/kernel";
import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AudioBuf,
  type AudioStream,
  decodeWav,
  encodeWav,
  HttpWorkerAsrFactory,
  HttpWorkerTtsFactory,
  NO_HINT,
  type ProviderConfig,
  ProviderConfigSchema,
  resample,
  type SpeechConfig,
  SpeechConfigSchema,
  SpeechModule,
  type SpeechService,
  ttsRequest,
} from "../src/index.js";
import { FakeEndpoints, speechEntries } from "./endpoints.js";

/** What the mock saw: headers and raw body of the last request. */
interface Seen {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

type Handler = (seen: Seen, res: ServerResponse) => void | Promise<void>;

const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** Serves `routes` (POST only); returns the base URL and the last request seen. */
async function serve(routes: Record<string, Handler>): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = { headers: {}, body: Buffer.alloc(0) };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const handler = routes[req.url ?? ""];
      if (!handler || req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      seen.headers = req.headers;
      seen.body = Buffer.concat(chunks);
      void Promise.resolve(handler(seen, res)).catch((e: unknown) => {
        res.destroy(e instanceof Error ? e : new Error(String(e)));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

function json(status: number, body: JsonValue): Handler {
  return (_seen, res) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
}

/** Streams `body` in pieces cut at the given byte offsets, 5 ms apart. */
function chunked(body: Uint8Array, cuts: number[], headers: Record<string, string>): Handler {
  return async (_seen, res) => {
    res.writeHead(200, headers);
    let last = 0;
    for (const c of [...cuts, body.length]) {
      await sleep(5);
      res.write(body.subarray(last, c));
      last = c;
    }
    res.end();
  };
}

function cfg(v: Record<string, JsonValue>): ProviderConfig {
  return ProviderConfigSchema.parse(v);
}

function config(v: Record<string, JsonValue>): SpeechConfig {
  return SpeechConfigSchema.parse(v);
}

function service(v: Record<string, JsonValue>): SpeechService {
  const c = config(v);
  const entries = speechEntries({
    asr: Object.fromEntries(Object.entries(c.asr).map(([n, p]) => [n, { ...p.settings, ...p }])),
    tts: Object.fromEntries(Object.entries(c.tts).map(([n, p]) => [n, { ...p.settings, ...p }])),
  });
  return SpeechModule.withDefaultFactories(c).buildService({
    endpoints: new FakeEndpoints(entries),
  });
}

/** The registry as Core's wiring fills it for one `http-worker` provider `w` at `url`. */
function workerEnv(family: "asr" | "tts", url: string) {
  return {
    endpoints: new FakeEndpoints([{ name: `speech.${family}.w`, provides: [family], url }]),
  };
}

function tone(): AudioBuf {
  return { sampleRate: 16_000, samples: Int16Array.from({ length: 320 }, (_, i) => i * 50) };
}

function contains(haystack: Buffer, needle: string): boolean {
  return haystack.includes(Buffer.from(needle));
}

async function collect(stream: AudioStream): Promise<AudioBuf[]> {
  const out: AudioBuf[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function flatten(chunks: AudioBuf[]): number[] {
  return chunks.flatMap((c) => [...c.samples]);
}

function pcmBytes(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const v = new DataView(out.buffer);
  for (const [i, s] of samples.entries()) v.setInt16(i * 2, s, true);
  return out;
}

function speechSamples(): number[] {
  return Array.from({ length: 1000 }, (_, i) => i * 7 - 3000);
}

function bodyJson(seen: Seen): JsonValue {
  return JSON.parse(seen.body.toString("utf8")) as JsonValue;
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error("expected a rejection");
}

// ------------------------------------------------------------------------ ASR

describe("ASR", () => {
  it("asr_http_worker", async () => {
    const { url, seen } = await serve({
      "/asr": json(200, {
        text: "早安",
        language: "zh",
        emotion: "happy",
        audio_events: ["laughter"],
        duration_ms: 20,
      }),
    });
    const svc = service({ asr: { local: { kind: "http-worker", url: `${url}/` } } });
    const [name, t] = await svc.transcribe(tone(), { language: "zh", prompt: "Miyoria" });
    expect(name).toBe("local");
    expect(t.text).toBe("早安");
    expect(t.language).toBe("zh");
    expect(t.emotion).toBe("happy");
    expect(t.audio_events).toEqual(["laughter"]);

    const ct = String(seen.headers["content-type"]);
    expect(ct.startsWith("multipart/form-data")).toBe(true);
    expect(contains(seen.body, 'name="audio"')).toBe(true);
    expect(contains(seen.body, "RIFF")).toBe(true);
    expect(contains(seen.body, 'name="language"')).toBe(true);
    expect(contains(seen.body, 'name="prompt"')).toBe(true);
    expect(contains(seen.body, "Miyoria")).toBe(true);
  });

  it("asr_http_worker_optional_fields_and_error_body", async () => {
    const { url } = await serve({
      "/ok/asr": json(200, { text: "hi" }),
      "/bad/asr": json(400, { error: "bad wav" }),
    });
    const build = (path: string) =>
      new HttpWorkerAsrFactory().build(
        "w",
        cfg({ kind: "http-worker", url: `${url}/${path}` }),
        workerEnv("asr", `${url}/${path}`),
      );

    const t = await build("ok").transcribe(tone(), NO_HINT);
    expect(t.text).toBe("hi");
    expect(t.audio_events).toEqual([]);
    expect(t.emotion).toBeNull();

    const err = await rejection(build("bad").transcribe(tone(), NO_HINT));
    expect(err).toContain("400");
    expect(err).toContain("bad wav");
  });

  it("asr_openai", async () => {
    const { url, seen } = await serve({
      "/v1/audio/transcriptions": json(200, { text: "hello" }),
    });
    const svc = service({
      asr: {
        groq: {
          kind: "openai",
          base_url: `${url}/v1`,
          api_key: "sk-test",
          model: "whisper-large-v3-turbo",
        },
      },
    });
    const [, t] = await svc.transcribe(tone(), { language: "en", prompt: null });
    expect(t.text).toBe("hello");
    expect(t.language).toBe("en");

    expect(seen.headers.authorization).toBe("Bearer sk-test");
    expect(contains(seen.body, 'name="file"')).toBe(true);
    expect(contains(seen.body, "whisper-large-v3-turbo")).toBe(true);
    expect(contains(seen.body, 'name="response_format"')).toBe(true);
    expect(contains(seen.body, "json")).toBe(true);
    expect(contains(seen.body, 'name="language"')).toBe(true);
    expect(contains(seen.body, 'name="prompt"')).toBe(false);
  });

  it("asr_error_falls_back_to_next_provider", async () => {
    const { url } = await serve({
      "/down/asr": (_s, res) => {
        res.writeHead(503, { "content-type": "text/plain" }).end("model loading");
      },
      "/up/asr": json(200, { text: "backup" }),
    });
    const base = {
      asr: {
        a_primary: { kind: "http-worker", url: `${url}/down` },
        b_backup: { kind: "http-worker", url: `${url}/up` },
      },
    };
    // default chain = name order
    const [name, t] = await service(base).transcribe(tone(), NO_HINT);
    expect([name, t.text]).toEqual(["b_backup", "backup"]);

    // chain with only the failing provider surfaces the error
    const err = await rejection(
      service({ ...base, asr_chain: ["a_primary"] }).transcribe(tone(), NO_HINT),
    );
    expect(err).toContain("503");
    expect(err).toContain("model loading");
  });

  it("asr_honours_the_abort_signal", async () => {
    const { url } = await serve({ "/asr": () => new Promise(() => undefined) });
    const svc = service({ asr: { w: { kind: "http-worker", url } } });
    const controller = new AbortController();
    const p = svc.transcribe(tone(), NO_HINT, controller.signal);
    setTimeout(() => controller.abort(new Error("stop")), 20);
    expect(await rejection(p)).toBe("stop");
  });
});

// ------------------------------------------------------------------------ TTS

describe("TTS", () => {
  it("tts_http_worker_streams_across_odd_byte_boundaries", async () => {
    const pcm = pcmBytes(speechSamples());
    const { url, seen } = await serve({
      // odd offsets, a 1-byte piece and a piece ending mid-sample
      "/tts": chunked(pcm, [3, 4, 5, 501, 1001, 1500], {
        "content-type": "audio/L16; rate=24000; channels=1",
        "x-sample-rate": "24000",
      }),
    });
    const svc = service({ tts: { qwen: { kind: "http-worker", url, voice: "default-voice" } } });

    const [name, stream] = await svc.synthesize(
      ttsRequest("哼", { language: "Chinese", emotion: "annoyed" }),
    );
    expect(name).toBe("qwen");
    const chunks = await collect(stream);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.sampleRate === 24_000)).toBe(true);
    expect(flatten(chunks)).toEqual(speechSamples());

    expect(bodyJson(seen)).toEqual({
      text: "哼",
      language: "Chinese",
      emotion: "annoyed",
      voice: "default-voice",
    });

    // a voice in the request wins over the configured one
    await collect((await svc.synthesize(ttsRequest("x", { voice: "other" })))[1]);
    expect((bodyJson(seen) as Record<string, JsonValue>).voice).toBe("other");
  });

  it("tts_http_worker_rate_from_content_type_and_missing_rate", async () => {
    const { url } = await serve({
      "/ct/tts": chunked(Uint8Array.of(1, 0, 2, 0), [1], {
        "content-type": "audio/L16; rate=16000",
      }),
      "/none/tts": chunked(Uint8Array.of(1, 0), [], {}),
    });
    const tts = (path: string) =>
      new HttpWorkerTtsFactory().build(
        "w",
        cfg({ kind: "http-worker", url: `${url}/${path}` }),
        workerEnv("tts", `${url}/${path}`),
      );

    const chunks = await collect(await tts("ct").synthesize(ttsRequest("")));
    expect(chunks.every((c) => c.sampleRate === 16_000)).toBe(true);
    expect(flatten(chunks)).toEqual([1, 2]);

    // no X-Sample-Rate and no rate= -> error (so the fallback chain moves on)
    expect(await rejection(tts("none").synthesize(ttsRequest("")))).toContain("sample rate");
  });

  it("tts_openai", async () => {
    const pcm = pcmBytes(speechSamples());
    const { url, seen } = await serve({
      "/v1/audio/speech": chunked(pcm, [1, 777, 1999], { "content-type": "audio/pcm" }),
    });
    const svc = service({
      tts: {
        cloud: {
          kind: "openai",
          base_url: `${url}/v1/`,
          api_key: "sk-tts",
          model: "gpt-4o-mini-tts",
          voice: "nova",
        },
      },
    });
    const [, stream] = await svc.synthesize(ttsRequest("hello"));
    const chunks = await collect(stream);
    expect(chunks.every((c) => c.sampleRate === 24_000)).toBe(true);
    expect(flatten(chunks)).toEqual(speechSamples());

    expect(seen.headers.authorization).toBe("Bearer sk-tts");
    expect(bodyJson(seen)).toEqual({
      model: "gpt-4o-mini-tts",
      input: "hello",
      voice: "nova",
      response_format: "pcm",
    });
  });

  it("tts_gpt_sovits", async () => {
    const pcm = pcmBytes(speechSamples());
    const { url, seen } = await serve({
      "/tts": chunked(pcm, [11, 600], { "content-type": "audio/x-raw" }),
    });
    const svc = service({
      tts: {
        sovits: {
          kind: "gpt-sovits",
          url,
          ref_audio_path: "refs/a.wav",
          prompt_text: "你好",
          prompt_lang: "zh",
          params: { speed_factor: 1.2 },
        },
      },
    });
    const [, stream] = await svc.synthesize(ttsRequest("こんにちは", { language: "Japanese" }));
    const chunks = await collect(stream);
    expect(chunks.every((c) => c.sampleRate === 32_000)).toBe(true);
    expect(flatten(chunks)).toEqual(speechSamples());

    expect(bodyJson(seen)).toEqual({
      text: "こんにちは",
      text_lang: "ja",
      ref_audio_path: "refs/a.wav",
      prompt_text: "你好",
      prompt_lang: "zh",
      media_type: "raw",
      streaming_mode: true,
      speed_factor: 1.2,
    });
  });

  it("tts_failure_falls_back", async () => {
    const { url } = await serve({
      "/a/tts": json(500, { error: "oom" }),
      "/b/tts": chunked(pcmBytes([5, 6, 7]), [], { "x-sample-rate": "22050" }),
    });
    const svc = service({
      tts: {
        a: { kind: "http-worker", url: `${url}/a` },
        b: { kind: "http-worker", url: `${url}/b` },
      },
      tts_chain: ["a", "b"],
    });
    const [name, stream] = await svc.synthesize(ttsRequest(""));
    expect(name).toBe("b");
    const chunks = await collect(stream);
    expect(chunks[0]?.sampleRate).toBe(22_050);
    expect(flatten(chunks)).toEqual([5, 6, 7]);
  });

  it("tts_vllm_omni_streams_raw_pcm", async () => {
    const pcm = pcmBytes(speechSamples());
    const { url, seen } = await serve({
      "/v1/audio/speech": chunked(pcm, [3, 641, 1500], {
        "x-audio-sample-rate": "24000",
        "x-audio-channels": "1",
      }),
    });
    const svc = service({
      tts: {
        qwen: {
          kind: "vllm-omni",
          base_url: `${url}/v1`,
          voice: "deepseek-chan",
          language: "Chinese",
          instructions: true,
          initial_codec_chunk_frames: 4,
          extra: { seed: 7 },
        },
      },
    });
    const [, stream] = await svc.synthesize(
      ttsRequest("哼,才不是在等你呢。", { instruct: "不耐煩" }),
    );
    const chunks = await collect(stream);
    expect(chunks.every((c) => c.sampleRate === 24_000)).toBe(true);
    expect(flatten(chunks)).toEqual(speechSamples());

    expect(bodyJson(seen)).toEqual({
      input: "哼,才不是在等你呢。",
      response_format: "pcm",
      stream: true,
      stream_format: "audio",
      language: "Chinese",
      voice: "deepseek-chan",
      instructions: "不耐煩",
      initial_codec_chunk_frames: 4,
      seed: 7,
    });
  });

  it("tts_vllm_omni_rejects_stereo", async () => {
    const { url } = await serve({
      "/audio/speech": chunked(pcmBytes([1, 2]), [], { "x-audio-channels": "2" }),
    });
    const svc = service({ tts: { q: { kind: "vllm-omni", base_url: url } } });
    expect(await rejection(svc.synthesize(ttsRequest("x")))).toContain("2-channel");
  });

  it("tts_stream_break_cancels_the_response", async () => {
    let closed = false;
    const { url } = await serve({
      "/tts": async (_seen, res) => {
        res.writeHead(200, { "x-sample-rate": "16000" });
        res.on("close", () => {
          closed = true;
        });
        res.write(pcmBytes([1, 2, 3]));
        // keeps "generating" forever
      },
    });
    const svc = service({ tts: { w: { kind: "http-worker", url } } });
    const [, stream] = await svc.synthesize(ttsRequest("x"));
    for await (const chunk of stream) {
      expect([...chunk.samples]).toEqual([1, 2, 3]);
      break;
    }
    for (let i = 0; i < 100 && !closed; i++) await sleep(10);
    expect(closed).toBe(true);
  });

  it("tts_idle_timeout_fails_the_stream", async () => {
    const { url } = await serve({
      "/tts": async (_seen, res) => {
        res.writeHead(200, { "x-sample-rate": "16000" });
        res.write(pcmBytes([1]));
      },
    });
    const svc = service({ tts: { w: { kind: "http-worker", url, timeout_secs: 1 } } });
    const [, stream] = await svc.synthesize(ttsRequest("x"));
    const err = await rejection(collect(stream));
    expect(err).toContain("audio stream failed");
  });
});

// --------------------------------------------------------------------- module

describe("module", () => {
  it("module_config_and_chains", () => {
    // empty config: starts, nothing available
    const empty = service({});
    expect(empty.hasAsr() || empty.hasTts()).toBe(false);

    // chains default to everything configured; explicit empty chain disables
    const svc = service({
      asr: { x: { kind: "http-worker", url: "http://127.0.0.1:1" } },
      tts: { y: { kind: "openai" } },
      tts_chain: [],
    });
    expect(svc.hasAsr()).toBe(true);
    expect(svc.hasTts()).toBe(false);

    // errors: unknown kind, unknown chain entry, bad settings
    const err = (v: Record<string, JsonValue>) => {
      try {
        service(v);
      } catch (error) {
        return errorMessage(error);
      }
      throw new Error("expected an error");
    };
    expect(err({ asr: { x: { kind: "nope" } } })).toContain("unknown ASR kind");
    expect(err({ tts: { x: { kind: "gpt-sovits", url: "u" } } })).toContain("speech.tts.x");
    expect(err({ asr_chain: ["ghost"] })).toContain("ghost");
    expect(err({ asr: { x: { kind: "http-worker", url: 5 } } })).toContain("speech.asr.x");
  });

  it("module_manifest_id", () => {
    const m = SpeechModule.withDefaultFactories(config({}));
    expect(m.manifest.id).toBe("speech");
  });

  it("wav_is_reexported_and_resample_available", () => {
    const a = tone();
    expect([...decodeWav(encodeWav(a)).samples]).toEqual([...a.samples]);
    expect(resample(a, 8_000).samples.length).toBe(160);
  });

  it("api_keys_stay_out_of_inspect_output", () => {
    const svc = service({
      asr: { o: { kind: "openai", api_key: "sk-secret-asr" } },
      tts: { o: { kind: "openai", api_key: "sk-secret-tts" } },
    });
    expect(inspect(svc, { depth: 5 })).not.toContain("sk-secret");
    expect(JSON.stringify(svc)).not.toContain("sk-secret");
  });
});
