// End of turn: the segmenter's hold, the worker client, the gate, Silero and the ASR aliases,
// against stand-ins for the worker (the real models only run in the live test).

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountRef } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ClipRecorder } from "../src/clips.js";
import { segmenterConfig, turnTiming } from "../src/config.js";
import {
  applyAliases,
  compileAliases,
  EnergyVad,
  HttpTurnJudge,
  Segmenter,
  type SegmenterConfig,
  SileroVad,
  TurnGate,
  type Utterance,
  VoiceConfigSchema,
} from "../src/index.js";
import type { SileroSocket } from "../src/silero.js";
import { waitUntil } from "./harness.js";
import { concat, silence, voice } from "./synth.js";

const TURN: Partial<SegmenterConfig> = {
  endSilenceMs: 600,
  turn: { stopMs: 200, maxSilenceMs: 1500, audioMs: 8000 },
};

function segmenter(config: Partial<SegmenterConfig> = TURN): Segmenter<EnergyVad> {
  return new Segmenter(new EnergyVad(), config);
}

function speech(ms = 1200): Int16Array {
  return concat(silence(200), voice(ms, 0.3));
}

function ask(seg: Segmenter<EnergyVad>): { id: number; samples: Int16Array } {
  const c = seg.takeCandidate();
  if (c === null) throw new Error("no candidate");
  return c;
}

describe("the segmenter with a turn model", () => {
  it("asks after the stop silence and not before", () => {
    const seg = segmenter();
    seg.push(speech());
    seg.push(silence(100));
    expect(seg.takeCandidate()).toBeNull();
    seg.push(silence(140));
    const c = ask(seg);
    expect(c.samples.length).toBeGreaterThan(16_000);
    expect(seg.takeCandidate()).toBeNull(); // once
    expect(seg.isActive()).toBe(true);
  });

  it("ends the utterance on the spot when the model says the turn is over", () => {
    const seg = segmenter();
    seg.push(speech());
    seg.push(silence(240));
    const u = seg.resolve(ask(seg).id, "complete") as Utterance;
    expect(u.endedBy).toBe("turn");
    expect(u.trailingSilenceMs).toBeLessThan(600);
    expect(seg.isActive()).toBe(false);
  });

  it("keeps listening past the end silence when the model says they are not done", () => {
    const seg = segmenter();
    seg.push(speech());
    seg.push(silence(240));
    expect(seg.resolve(ask(seg).id, "incomplete")).toBeNull();
    expect(seg.push(silence(700))).toEqual([]); // 940 ms of silence: today this was the end
    expect(seg.isActive()).toBe(true);
    const [u] = seg.push(silence(700));
    expect(u?.endedBy).toBe("timeout");
  });

  it("makes one utterance of a sentence with a long pause in it", () => {
    const seg = segmenter();
    seg.push(speech(800));
    seg.push(silence(240));
    expect(seg.resolve(ask(seg).id, "incomplete")).toBeNull();
    seg.push(silence(600));
    seg.push(voice(800, 0.3));
    seg.push(silence(240));
    const u = seg.resolve(ask(seg).id, "complete") as Utterance;
    expect(u.speechMs).toBeGreaterThan(2_000);
  });

  it("ignores an answer about a moment that passed", () => {
    const seg = segmenter();
    seg.push(speech());
    seg.push(silence(240));
    const c = ask(seg);
    seg.push(voice(300, 0.3));
    expect(seg.askedId()).toBe(0);
    expect(seg.resolve(c.id, "complete")).toBeNull();
    expect(seg.isActive()).toBe(true);
  });

  it("falls back to the end silence when the model does not answer", () => {
    const seg = segmenter();
    seg.push(speech());
    seg.push(silence(240));
    expect(seg.resolve(ask(seg).id, "unknown")).toBeNull();
    const [u] = seg.push(silence(400));
    expect(u?.endedBy).toBe("silence");
  });

  it("ends at once when the model answers after the end silence went by", () => {
    const seg = segmenter();
    seg.push(speech());
    seg.push(silence(240));
    const c = ask(seg);
    seg.push(silence(500));
    expect((seg.resolve(c.id, "unknown") as Utterance).endedBy).toBe("silence");
  });

  it("does not hang when an answer never comes", () => {
    const seg = segmenter();
    seg.push(speech());
    seg.push(silence(240));
    ask(seg);
    const [u] = seg.push(silence(1400));
    expect(u?.endedBy).toBe("timeout");
  });

  it("does not ask about a blip", () => {
    const seg = segmenter();
    seg.push(concat(silence(200), voice(100, 0.3)));
    seg.push(silence(300));
    expect(seg.takeCandidate()).toBeNull();
  });

  it("gives the model at most the end of the turn", () => {
    const seg = segmenter({ ...TURN, turn: { stopMs: 200, maxSilenceMs: 1500, audioMs: 500 } });
    seg.push(speech(2000));
    seg.push(silence(240));
    expect(ask(seg).samples.length).toBe(8_000);
  });

  it("marks which candidate an utterance is exactly the audio of", () => {
    const seg = segmenter();
    seg.push(speech());
    seg.push(silence(240));
    const c = ask(seg);
    const ahead = seg.peek();
    seg.resolve(c.id, "incomplete");
    const [u] = seg.push(silence(1400));
    expect(u?.candidate).toBe(c.id);
    expect(u?.samples).toEqual(ahead);
  });

  it("without a model it does what it always did", () => {
    const seg = segmenter({});
    const [u] = [...seg.push(speech()), ...seg.push(silence(700))];
    expect(u?.endedBy).toBe("silence");
    expect(u?.candidate).toBeNull();
    expect(seg.takeCandidate()).toBeNull();
  });
});

describe("the config", () => {
  it("leaves every model off by default", () => {
    const c = VoiceConfigSchema.parse({});
    expect(c.turn_engine).toBe("silence");
    expect(c.vad_engine).toBe("energy");
    expect(c.turn_early_asr).toBe(false);
    expect(c.asr_while_paused).toBe(false);
    expect(c.clip_dir).toBeNull();
    expect(c.asr_aliases).toEqual({});
    expect(turnTiming(c)).toBeNull();
    expect(segmenterConfig(c).turn).toBeNull();
  });

  it("turns the model's timing on with the engine", () => {
    const c = VoiceConfigSchema.parse({ turn_engine: "smart-turn", turn_max_silence_ms: 100 });
    expect(turnTiming(c)).toEqual({ stopMs: 200, maxSilenceMs: 200, audioMs: 8000 });
  });
});

describe("the worker client", () => {
  let server: Server | null = null;

  afterEach(async () => {
    const s = server;
    server = null;
    if (s) await new Promise((resolve) => s.close(resolve));
  });

  async function worker(
    handle: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
  ): Promise<string> {
    const s = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (d: Buffer) => parts.push(d));
      req.on("end", () => handle(req, res, Buffer.concat(parts)));
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  function judge(url: string, now: () => number = Date.now, warnings: string[] = []) {
    return new HttpTurnJudge({
      url,
      timeoutMs: 80,
      now,
      warn: (m) => warnings.push(m),
    });
  }

  const never = new AbortController().signal;

  it("sends the raw PCM and returns the answer", async () => {
    let got: Buffer | null = null;
    let rate = "";
    const url = await worker((req, res, body) => {
      got = body;
      rate = String(req.headers["x-sample-rate"]);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ complete: true, probability: 0.9, inference_ms: 12 }));
    });
    const answer = await judge(url).ask(Int16Array.of(1, -2), 16_000, never);
    expect(answer).toEqual({ complete: true, probability: 0.9 });
    expect(rate).toBe("16000");
    expect([...(got as unknown as Buffer)]).toEqual([1, 0, 254, 255]);
  });

  it("gives up after the timeout, without a rejection", async () => {
    const url = await worker(() => undefined);
    const t0 = Date.now();
    expect(await judge(url).ask(Int16Array.of(1), 16_000, never)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
    server?.closeAllConnections();
  });

  it("does not ask a worker that failed again for a while, and warns once", async () => {
    let calls = 0;
    const url = await worker((_req, res) => {
      calls++;
      res.statusCode = 503;
      res.end("{}");
    });
    let now = 1_000;
    const warnings: string[] = [];
    const j = judge(url, () => now, warnings);
    expect(await j.ask(Int16Array.of(1), 16_000, never)).toBeNull();
    expect(await j.ask(Int16Array.of(1), 16_000, never)).toBeNull();
    expect(calls).toBe(1);
    now += 31_000;
    expect(await j.ask(Int16Array.of(1), 16_000, never)).toBeNull();
    expect(calls).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it("treats a worker that is not there as no answer", async () => {
    const j = judge("http://127.0.0.1:9");
    expect(await j.ask(Int16Array.of(1), 16_000, never)).toBeNull();
  });
});

describe("the turn gate", () => {
  const me: AccountRef = { platform: "discord", id: "u1" };
  const other: AccountRef = { platform: "discord", id: "u2" };

  it("holds while they talk and for the confirmation after", () => {
    let now = 0;
    const gate = new TurnGate(() => now);
    expect(gate.held("g", [me])).toBe(false);
    gate.hold("g", me);
    expect(gate.held("g", [me])).toBe(true);
    expect(gate.held("g", [other])).toBe(false);
    expect(gate.held("g2", [me])).toBe(false);
    gate.settle("g", me, 400);
    now = 399;
    expect(gate.held("g", [me])).toBe(true);
    now = 400;
    expect(gate.held("g", [me])).toBe(false);
  });

  it("does not hold a reply that answers nobody", () => {
    const gate = new TurnGate(() => 0);
    gate.hold("g", me);
    expect(gate.held("g", [])).toBe(false);
  });

  it("lets a waiting reply go when they are done", async () => {
    const gate = new TurnGate(Date.now);
    gate.hold("g", me);
    let done = false;
    const waiting = gate.wait("g", [me], 5_000, new AbortController().signal).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false);
    gate.settle("g", me, 0);
    await waiting;
    expect(done).toBe(true);
  });

  it("never holds a reply longer than the limit", async () => {
    const gate = new TurnGate(Date.now);
    gate.hold("g", me);
    const t0 = Date.now();
    await gate.wait("g", [me], 60, new AbortController().signal);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("stops waiting when the line is cancelled", async () => {
    const gate = new TurnGate(Date.now);
    gate.hold("g", me);
    const c = new AbortController();
    const waiting = gate.wait("g", [me], 5_000, c.signal);
    c.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow();
  });
});

class FakeSocket implements SileroSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  closed = false;
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.#listeners.get(event) ?? []) l(...args);
  }
}

describe("silero", () => {
  const quiet = new Int16Array(512);
  const loud = voice(32, 0.3);

  function vad(now: () => number = Date.now): { vad: SileroVad; sockets: FakeSocket[] } {
    const sockets: FakeSocket[] = [];
    const v = new SileroVad({
      url: "http://127.0.0.1:8006",
      threshold: 0.5,
      now,
      connect: (url) => {
        expect(url).toBe("ws://127.0.0.1:8006/vad");
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    return { vad: v, sockets };
  }

  it("takes the model's word, with hysteresis", () => {
    const { vad: v, sockets } = vad();
    const s = sockets[0] as FakeSocket;
    s.emit("message", "0.9");
    expect(v.isSpeech(quiet)).toBe(true);
    s.emit("message", "0.40");
    expect(v.isSpeech(quiet)).toBe(true); // above threshold - 0.15
    s.emit("message", "0.20");
    expect(v.isSpeech(loud)).toBe(false);
    expect(s.sent).toHaveLength(3);
    expect(s.sent[0]?.byteLength).toBe(1024);
  });

  it("uses the energy detector until the model answers", () => {
    const { vad: v } = vad();
    expect(v.isSpeech(quiet)).toBe(false);
    expect(v.isSpeech(loud)).toBe(true);
  });

  it("goes back to the energy detector when the answers stop", () => {
    let now = 0;
    const { vad: v, sockets } = vad(() => now);
    (sockets[0] as FakeSocket).emit("message", "0.9");
    now = 600;
    expect(v.isSpeech(quiet)).toBe(false);
  });

  it("connects again after a while when the socket is lost", () => {
    let now = 0;
    const { vad: v, sockets } = vad(() => now);
    (sockets[0] as FakeSocket).emit("close");
    v.isSpeech(quiet);
    expect(sockets).toHaveLength(1);
    now = 1_500;
    v.isSpeech(quiet);
    expect(sockets).toHaveLength(2);
  });

  it("does not pile frames up behind a slow worker", () => {
    const { vad: v, sockets } = vad();
    const s = sockets[0] as FakeSocket;
    s.bufferedAmount = 1 << 20;
    v.isSpeech(quiet);
    expect(s.sent).toHaveLength(0);
  });

  it("closes its socket and does not come back", () => {
    let now = 0;
    const { vad: v, sockets } = vad(() => now);
    v.close();
    expect((sockets[0] as FakeSocket).closed).toBe(true);
    now = 60_000;
    v.isSpeech(quiet);
    expect(sockets).toHaveLength(1);
  });
});

describe("asr aliases", () => {
  it("puts misheard names right, longest first", () => {
    const a = compileAliases({ 咪: "x", 咪o: "Miyo", "deep sick": "DeepSeek" }, true);
    expect(applyAliases("咪o 你在嗎", a)).toBe("Miyo 你在嗎");
    expect(applyAliases("我用 Deep Sick 寫的", a)).toBe("我用 DeepSeek 寫的");
  });

  it("matches Latin words whole, so a name does not hit inside a word", () => {
    const a = compileAliases({ meo: "Miyo" }, true);
    expect(applyAliases("Meo 在嗎", a)).toBe("Miyo 在嗎");
    expect(applyAliases("someone said it", a)).toBe("someone said it");
    expect(applyAliases("叫meo啦", a)).toBe("叫Miyo啦");
  });

  it("finds what ASR wrote in Simplified after it became Traditional", () => {
    const a = compileAliases({ 米优: "Miyo" }, true);
    expect(applyAliases("米優你好", a)).toBe("Miyo你好");
  });

  it("does nothing without a table, and takes regex characters literally", () => {
    expect(applyAliases("a.b", compileAliases({}, true))).toBe("a.b");
    expect(applyAliases("axb a.b", compileAliases({ "a.b": "c" }, true))).toBe("axb c");
    expect(applyAliases("x", compileAliases({ x: "$&$1" }, true))).toBe("$&$1");
  });
});

describe("clips", () => {
  it("survives a folder it cannot write", async () => {
    const warnings: string[] = [];
    const file = join(await mkdtemp(join(tmpdir(), "miyoria-clips-")), "file");
    await writeFile(file, "x");
    new ClipRecorder(file, (m) => warnings.push(m)).save("ended", Int16Array.of(1), 16_000);
    await waitUntil(() => warnings.length === 1);
    expect(warnings[0]).toContain("voice clip");
  });

  it("keeps the audio and the transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miyoria-clips-"));
    new ClipRecorder(dir, () => undefined).save("utterance", Int16Array.of(1, 2), 16_000, "你好");
    const folder = join(dir, "utterances");
    let files: string[] = [];
    for (let i = 0; i < 100 && files.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
      files = await readdir(folder).catch(() => []);
    }
    expect(files.filter((f) => f.endsWith(".wav"))).toHaveLength(1);
    const txt = files.find((f) => f.endsWith(".txt")) as string;
    expect(await readFile(join(folder, txt), "utf8")).toBe("你好");
    await rm(dir, { recursive: true, force: true });
  });
});
