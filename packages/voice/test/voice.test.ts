// `voice` module tests: listening, consent, speaking, barge-in and commands, with a fake voice
// node and fake ASR / TTS providers (port of `tests/voice.rs`).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type CommandRegistry,
  CommandRegistryKey,
  CommandsModule,
  replyEphemeral,
} from "@miyoria/commands";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type Subscription,
} from "@miyoria/kernel";
import { type ChatRequest, type LlmRouter, LlmRouterKey } from "@miyoria/llm";
import {
  type AsrHint,
  type AsrProvider,
  type AudioBuf,
  type AudioChunk,
  type AudioStream,
  SpeechService,
  SpeechServiceKey,
  type Transcript,
  type TtsProvider,
  type TtsRequest,
} from "@miyoria/speech";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  ActuatorExecutorKey,
  type AffectState,
  AffectStateKey,
  type ContextKey,
  type JsonObject,
  type JsonValue,
  ModerationKey,
  type ModerationService,
  type OutputCheck,
  type PlaybackState,
  SpeechPauseKey,
  type TurnFocus,
  TurnFocusViewKey,
  VoiceFloorKey,
  VoiceSinkKey,
  type VoiceUtterance,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceModule } from "../src/index.js";
import {
  deepseekVoice,
  Harness,
  type Node,
  nextEvent,
  SELF_ID,
  sleepMs,
  waitUntil,
} from "./harness.js";

const RATE = 16_000;

/** 180 Hz voice-like tone, amplitude-modulated at 4 Hz. */
function voice(ms: number): Int16Array {
  return Int16Array.from({ length: Math.floor((RATE * ms) / 1000) }, (_, i) => {
    const t = i / RATE;
    const w = 2 * Math.PI * 180 * t;
    const carrier = Math.sin(w) * 0.6 + Math.sin(2 * w) * 0.3;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    return Math.trunc(carrier * env * 0.3 * 32767);
  });
}

function utteranceAudio(): Int16Array {
  const v = voice(1200);
  const out = new Int16Array(RATE / 5 + v.length + RATE);
  out.set(v, RATE / 5);
  return out;
}

class FakeAsr implements AsrProvider {
  readonly name = "fake-asr";
  text = "";
  calls: Array<[number, AsrHint]> = [];

  async transcribe(audio: AudioBuf, hint: AsrHint): Promise<Transcript> {
    expect(audio.sampleRate).toBe(16_000);
    this.calls.push([audio.samples.length, { ...hint }]);
    return { text: this.text, language: "zh", emotion: "happy", audio_events: ["laughter"] };
  }
}

class FakeTts implements TtsProvider {
  readonly name = "fake-tts";
  requests: TtsRequest[] = [];
  /** What the worker reports having waited for its GPU. */
  queueMs: number | undefined = undefined;
  /** Keep the stream open after the audio (a long generation). */
  endless = false;
  /** Fail every request with this message. */
  failWith: string | null = null;

  async synthesize(request: TtsRequest): Promise<AudioStream> {
    this.requests.push(request);
    if (this.failWith !== null) throw new Error(this.failWith);
    const endless = this.endless;
    const queueMs = this.queueMs;
    const chunks: AudioChunk[] = [
      { sampleRate: 24_000, samples: new Int16Array(0) },
      { sampleRate: 24_000, samples: new Int16Array(2400).fill(100) },
      { sampleRate: 24_000, samples: new Int16Array(2400).fill(-100) },
    ];
    const stream: AudioStream = (async function* () {
      yield* chunks;
      if (endless) await new Promise(() => undefined);
    })();
    if (queueMs !== undefined) stream.queueMs = queueMs;
    return stream;
  }
}

/** Stands in for the `speech` module. */
class FakeSpeech implements Module {
  readonly manifest = defineManifest("speech", "Fake speech");

  constructor(
    readonly asr: FakeAsr,
    readonly tts: FakeTts,
  ) {}

  async start(ctx: ModuleContext): Promise<void> {
    ctx.provide(SpeechServiceKey, new SpeechService([this.asr], [this.tts]));
  }
}

const voiceCtx: ContextKey = { platform: "discord", scope: "g1", channel: "vc1", kind: "voice" };

function account(id: string): AccountRef {
  return { platform: "discord", id };
}

class Env {
  constructor(
    readonly h: Harness,
    readonly asr: FakeAsr,
    readonly tts: FakeTts,
    readonly settings: MemorySettingsStore,
    readonly node: Node,
    readonly module: VoiceModule,
  ) {}

  speakStream(stream: number, user: string, audio: Int16Array): void {
    this.node.sendJson({
      type: "stream_open",
      stream,
      guild: "g1",
      channel: "vc1",
      user_id: user,
      display_name: `nick-${user}`,
      sample_rate: 16000,
    });
    this.node.sendAudio(stream, audio);
    this.node.sendJson({ type: "stream_close", stream });
  }

  registry(): CommandRegistry {
    return this.h.services.require(CommandRegistryKey);
  }

  async command(
    path: string,
    invoker: string,
    args: Record<string, string> = {},
    guild = "g1",
  ): Promise<{ text: string; ephemeral: boolean }> {
    const reply = await this.registry().dispatch({
      path: path.split(/\s+/),
      args,
      invoker: account(invoker),
      invoker_display_name: invoker,
      context: { platform: "discord", scope: guild, channel: "text1", kind: "channel" },
      // Go Live needs moderator+; guild admins have it.
      invoker_is_guild_admin: invoker.startsWith("admin"),
    });
    const declared = this.registry().get(path.split(/\s+/))?.ephemeral ?? true;
    return { text: reply.text, ephemeral: replyEphemeral(declared, reply) };
  }
}

let env: Env | null = null;

afterEach(async () => {
  await env?.h.stop();
  env = null;
});

/** What a current voice node announces. */
const NODE_CAPS = ["play_duck", "play_pause"];

async function boot(
  voiceConfig: JsonObject = {},
  router: Pick<LlmRouter, "complete"> | null = null,
  capabilities: string[] = NODE_CAPS,
): Promise<Env> {
  const asr = new FakeAsr();
  asr.text = "这个游戏好难";
  const tts = new FakeTts();
  const settings = new MemorySettingsStore();
  const module = new VoiceModule("deepseek-chan", deepseekVoice());
  const h = await Harness.start(
    {},
    [
      [new FakeSpeech(asr, tts), null],
      [new CommandsModule(), null],
      [module, voiceConfig as JsonValue],
    ],
    (services) => {
      services.provide("app", SettingsStoreKey, settings);
      if (router) services.provide("app", LlmRouterKey, router as LlmRouter);
    },
  );
  expect(h.moduleState("voice").state).toBe("running");
  const node = await h.node(SELF_ID, capabilities);
  node.sendJson({
    type: "voice_state",
    guild: "g1",
    channel: "vc1",
    participants: [
      { user_id: "u1", display_name: "小明" },
      { user_id: "u2", display_name: "阿華" },
      { user_id: SELF_ID, display_name: "DeepSeek-chan", is_self: true },
    ],
  });
  node.sendJson({ type: "joined", guild: "g1", channel: "vc1" });
  const link = h.link();
  await waitUntil(() => link.participants("g1").length === 3);
  env = new Env(h, asr, tts, settings, node, module);
  return env;
}

async function nextUtterance(sub: Subscription): Promise<VoiceUtterance> {
  for (;;) {
    const ev = (await nextEvent(sub)).event;
    if (ev.type === "voice_utterance") return ev.data;
  }
}

async function readPlayback(node: Node): Promise<[number, number, number]> {
  const start = await node.recvType("play_start");
  const id = start.play as number;
  const rate = start.sample_rate as number;
  let samples = 0;
  for (;;) {
    const msg = await node.recv();
    if (msg.kind === "binary") samples += (msg.data.length - 5) / 2;
    else if (msg.kind === "text" && msg.text.includes("play_end")) return [id, rate, samples];
    else throw new Error(`unexpected ${msg.kind}`);
  }
}

function finish(node: Node, play: number): void {
  node.sendJson({ type: "playback", play, state: "started" });
  node.sendJson({ type: "playback", play, state: "finished" });
}

describe("voice", () => {
  it("transcribes_utterances", async () => {
    const e = await boot({ asr_prompt: "DeepSeek醬" });
    const events = e.h.subscribe(["voice.utterance", "voice.latency"]);
    e.speakStream(1, "u1", utteranceAudio());

    const u = await nextUtterance(events);
    expect(u.text).toBe("這個遊戲好難");
    expect(u.speaker.account).toEqual(account("u1"));
    expect(u.speaker.display_name).toBe("小明"); // name from participants
    expect(u.context).toEqual(voiceCtx);
    expect(u.language).toBe("zh");
    expect(u.emotion).toBe("happy");
    expect(u.audio_events).toEqual(["laughter"]);
    expect(Date.parse(u.ended_at)).toBeGreaterThan(Date.parse(u.started_at));
    const latency = (await nextEvent(events)).event;
    if (latency.type !== "custom") throw new Error(`unexpected ${latency.type}`);
    expect(latency.data.topic).toBe("voice.latency");
    const payload = latency.data.payload as Record<string, JsonValue>;
    expect(payload.stage).toBe("asr");
    expect(payload.provider).toBe("fake-asr");
    expect(typeof payload.asr_ms).toBe("number");
    expect(e.asr.calls.length).toBe(1);
    // About 0.2 s pre-roll + 1.2 s speech + 0.2 s tail.
    const [len, hint] = e.asr.calls[0] as [number, AsrHint];
    expect(len).toBeGreaterThanOrEqual(RATE);
    expect(len).toBeLessThan(RATE * 2);
    expect(hint.prompt).toBe("DeepSeek醬");
    expect(hint.language).toBeNull();

    // Hallucinations and silence produce nothing.
    e.asr.text = "谢谢观看";
    e.speakStream(2, "u1", utteranceAudio());
    e.speakStream(3, "u1", new Int16Array(RATE * 2));
    await waitUntil(() => e.asr.calls.length === 2);
    e.asr.text = "最后一句";
    e.speakStream(4, "u1", utteranceAudio());
    expect((await nextUtterance(events)).text).toBe("最後一句");
    expect(e.asr.calls.length).toBe(3); // silence never reaches ASR
  });

  it("consent_is_respected", async () => {
    const e = await boot();
    const events = e.h.subscribe(["voice.utterance"]);

    const reply = await e.command("voice consent", "u2", { state: "off" });
    expect(reply.text).toBe("已更新：她在語音頻道中不會聽你說話。");
    expect(reply.ephemeral).toBe(true);
    expect((await e.command("voice consent", "u2")).text).toBe(
      "目前設定：她在語音頻道中不會聽你說話。",
    );
    expect(await e.settings.get("_global", "voice_consent:discord:u2")).toBe(false);

    e.speakStream(1, "u2", utteranceAudio());
    e.speakStream(2, "u1", utteranceAudio());
    expect((await nextUtterance(events)).speaker.account.id).toBe("u1");
    expect(e.asr.calls.length).toBe(1); // u2 never reached ASR

    // Her own account is never transcribed either.
    e.speakStream(3, SELF_ID, utteranceAudio());
    await e.command("voice consent", "u2", { state: "on" });
    e.speakStream(4, "u2", utteranceAudio());
    expect((await nextUtterance(events)).speaker.account.id).toBe("u2");
    expect(e.asr.calls.length).toBe(2);
  });

  it("opt_in_policy_drops_unknown_users", async () => {
    const e = await boot({ consent: "opt-in", to_traditional: false });
    const events = e.h.subscribe(["voice.utterance"]);
    e.speakStream(1, "u1", utteranceAudio());
    await e.command("voice consent", "u2", { state: "on" });
    e.speakStream(2, "u2", utteranceAudio());
    const u = await nextUtterance(events);
    expect(u.speaker.account.id).toBe("u2");
    expect(u.text).toBe("这个游戏好难"); // conversion disabled
    expect(e.asr.calls.length).toBe(1);
  });

  it("speaks_through_tts", async () => {
    const e = await boot();
    const events = e.h.subscribe(["voice.playback", "voice.latency"]);
    const synth = e.h.subscribe(["voice.synthesis"]);
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(
      voiceCtx,
      "<emo:annoyed>哼,才不是在等你呢。<pause 300/>",
      "annoyed",
      null,
    );
    // The overlay hears that her line went to TTS before it plays.
    const asked = (await nextEvent(synth)).event;
    expect(asked).toEqual({
      type: "custom",
      data: { topic: "voice.synthesis", payload: { context: { ...voiceCtx }, turn: null } },
    });
    const [id, rate, samples] = await readPlayback(e.node);
    expect([rate, samples]).toEqual([24_000, 4800]);
    e.node.sendJson({ type: "playback", play: id, state: "started" });
    e.node.sendJson({ type: "playback", play: id, state: "finished" });
    expect(await speaking).toBe("completed");

    const req = e.tts.requests[0] as TtsRequest;
    expect(req.text).toBe("哼,才不是在等你呢。");
    expect(req.language).toBe("Chinese");
    expect(req.emotion).toBe("annoyed");
    expect(req.instruct).toBe("不耐煩、拖長音");
    expect(req.voice).toBe("deepseek-chan");

    const states: PlaybackState[] = [];
    let firstAudio: JsonValue | undefined;
    while (states.length < 2) {
      const ev = (await nextEvent(events)).event;
      if (ev.type === "voice_playback") {
        expect(ev.data.text).toBe("哼,才不是在等你呢。");
        states.push(ev.data.state);
      } else if (ev.type === "custom") {
        const p = ev.data.payload as Record<string, JsonValue>;
        expect(p.stage).toBe("tts");
        firstAudio = p.first_audio_ms;
      } else {
        throw new Error(`unexpected ${ev.type}`);
      }
    }
    expect(states).toEqual(["started", "finished"]);
    expect(typeof firstAudio).toBe("number");

    // Nothing left after stripping tags: nothing to say.
    expect(await sink.speak(voiceCtx, "<silence/>", null, null)).toBe("completed");
    expect(e.tts.requests.length).toBe(1);
  });

  it("barge_in_stops_playback", async () => {
    // The pre-v2 mode: anybody talking long enough stops her.
    const e = await boot({ barge_in: "stop" });
    e.tts.endless = true;
    const events = e.h.subscribe(["voice.playback"]);
    const sink = e.h.services.require(VoiceSinkKey);
    let finished = false;
    const speaking = sink.speak(voiceCtx, "我跟你說喔", null, null).finally(() => {
      finished = true;
    });
    const start = await e.node.recvType("play_start");
    const id = start.play as number;
    const started = (await nextEvent(events)).event;
    expect(started.type === "voice_playback" && started.data.state).toBe("started");

    // A short "嗯" does not interrupt her; talking over her does.
    e.node.sendJson({
      type: "stream_open",
      stream: 9,
      guild: "g1",
      channel: "vc1",
      user_id: "u1",
      display_name: "",
      sample_rate: 16000,
    });
    e.node.sendAudio(9, voice(300));
    e.node.sendAudio(9, new Int16Array(RATE / 2));
    await sleepMs(200);
    expect(finished).toBe(false);
    e.node.sendAudio(9, voice(1000));

    expect(await e.node.recvType("play_stop")).toEqual({
      type: "play_stop",
      play: id,
      fade_ms: 150,
    });
    expect(await speaking).toBe("interrupted");
    const ended = (await nextEvent(events)).event;
    expect(ended.type === "voice_playback" && ended.data.state).toBe("interrupted");
  });

  it("barge_in_can_be_ignored", async () => {
    const e = await boot({ barge_in: "ignore" });
    const sink = e.h.services.require(VoiceSinkKey);
    let finished = false;
    const speaking = sink.speak(voiceCtx, "我跟你說喔", null, null).finally(() => {
      finished = true;
    });
    const [id] = await readPlayback(e.node);
    e.speakStream(9, "u1", utteranceAudio());
    await sleepMs(300);
    expect(finished).toBe(false);
    e.node.sendJson({ type: "playback", play: id, state: "finished" });
    expect(await speaking).toBe("completed");
  });

  it("join_and_leave_commands", async () => {
    const e = await boot();
    const registry = e.registry();
    expect(registry.get(["voice", "join"])).toBeDefined();
    expect(registry.groupInfo(["voice"])?.guild_only).toBe(true);

    const gate = e.h.sup.bus.subscribe("gate.decision");
    const joining = e.command("voice join", "u7", {}, "g2");
    expect(await e.node.recvType("join")).toEqual({ type: "join", guild: "g2", user_id: "u7" });
    e.node.sendJson({ type: "joined", guild: "g2", channel: "vc2" });
    const reply = await joining;
    expect(reply.ephemeral).toBe(false);
    expect(reply.text).toContain("`/me`");
    // The command went through the gate as an overriding `command` principal.
    const decision = gate.tryRecv()?.event;
    expect(decision?.type === "custom" && decision.data.payload).toMatchObject({
      capability: "voice.join",
      allowed: true,
      principal: { kind: "command", requester: { id: "u7" }, override: true },
    });

    const left = await e.command("voice leave", "u7");
    expect(left.text).toBe("她已離開語音頻道。");
    expect((await e.node.recvType("leave")).guild).toBe("g1");

    // Stopping the module removes its commands.
    await e.h.sup.disable("voice");
    expect(registry.get(["voice", "join"])).toBeUndefined();
    expect(registry.get(["voice", "consent"])).toBeUndefined();
  });

  it("golive_commands", async () => {
    const e = await boot();
    const registry = e.registry();
    expect(registry.get(["voice", "golive", "start"])).toBeDefined();
    expect(registry.groupDescription(["voice", "golive"])).toContain("Go Live");
    // Plain users may look, not start.
    expect((await e.command("voice golive start", "u7")).text).toContain("voice.golive");

    // Not in a voice channel: joins the invoker's channel first, then goes live.
    const joining = e.command("voice golive start", "admin7", {}, "g2");
    expect(await e.node.recvType("join")).toEqual({
      type: "join",
      guild: "g2",
      user_id: "admin7",
    });
    e.node.sendJson({ type: "joined", guild: "g2", channel: "vc2" });
    expect((await e.node.recvType("golive_start")).guild).toBe("g2");
    const joined = await joining;
    expect(joined.ephemeral).toBe(false);
    expect(joined.text).toContain("`/me`");
    expect(joined.text).toContain("已開始 Go Live");

    const starting = e.command("voice golive start", "admin7");
    const req = await e.node.recvType("golive_start");
    expect(req.guild).toBe("g1");
    expect(req.source).toBe("rtmp://127.0.0.1:1935/live/miyoria");
    expect((await starting).text).toContain("已開始 Go Live");

    // The node reports progress; `/golive status` mirrors it.
    e.node.sendJson({ type: "golive", guild: "g1", state: "live" });
    await waitUntil(() => e.h.link().golive("g1")?.state === "live");
    const live = await e.command("voice golive status", "u7");
    expect(live.ephemeral).toBe(false);
    expect(live.text).toContain("直播中");

    // A second start is refused while it runs.
    expect((await e.command("voice golive start", "admin7")).text).toContain("已經在進行中");

    const stopping = e.command("voice golive stop", "admin7");
    expect((await e.node.recvType("golive_stop")).guild).toBe("g1");
    e.node.sendJson({ type: "golive", guild: "g1", state: "stopped", reason: "stop requested" });
    await waitUntil(() => e.h.link().golive("g1")?.state === "stopped");
    expect((await stopping).text).toBe("已結束 Go Live。");
    expect((await e.command("voice golive status", "u7")).text).toContain("未直播");
  });

  it("golive_start_takes_a_source_override", async () => {
    const e = await boot();
    const starting = e.command("voice golive start", "admin7", { source: "srt://127.0.0.1:9999" });
    expect((await e.node.recvType("golive_start")).source).toBe("srt://127.0.0.1:9999");
    await starting;
  });

  // ── TS-specific ─────────────────────────────────────────────────────────────

  it("tts_translate_speaks_the_translation_and_keeps_the_original_for_subtitles", async () => {
    const asked: ChatRequest[] = [];
    const router = {
      async complete(purpose: string, request: ChatRequest) {
        expect(purpose).toBe("fast");
        asked.push(request);
        const line = request.messages.at(-1)?.content;
        if (line === "壞掉") throw new Error("model down");
        return { text: ` ja(${String(line)}) ` } as never;
      },
    };
    const e = await boot({ tts_translate: "Japanese" }, router);
    const events = e.h.subscribe(["voice.playback"]);
    const sink = e.h.services.require(VoiceSinkKey);

    // Prepared early (when the agent queues the sentence), spoken later: translated once.
    sink.prepare?.(voiceCtx, "<emo:happy>你好啊");
    const speaking = sink.speak(voiceCtx, "<emo:happy>你好啊", "happy", null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await speaking).toBe("completed");
    expect(asked.length).toBe(1);
    expect(asked[0]?.thinking).toBe(false);
    expect(e.tts.requests[0]).toMatchObject({ text: "ja(你好啊)", language: "Japanese" });
    const started = (await nextEvent(events)).event;
    expect(started.type === "voice_playback" && started.data.text).toBe("你好啊");

    // A failed translation still speaks, untranslated.
    const fallback = sink.speak(voiceCtx, "壞掉", null, null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await fallback).toBe("completed");
    expect(e.tts.requests[1]?.text).toBe("壞掉");
  });

  it("a_spoken_line_from_the_reply_is_said_without_a_translation_call", async () => {
    const asked: ChatRequest[] = [];
    const router = {
      async complete(_purpose: string, request: ChatRequest) {
        asked.push(request);
        return { text: "ja(?)" } as never;
      },
    };
    const e = await boot({ tts_translate: "Japanese" }, router);
    const sink = e.h.services.require(VoiceSinkKey);
    expect(sink.speaksIn).toBe("Japanese");
    sink.prepare?.(voiceCtx, "真的嗎?", "えっ、本当に?");
    const speaking = sink.speak(voiceCtx, "真的嗎?", null, null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await speaking).toBe("completed");
    expect(asked.length).toBe(0);
    expect(e.tts.requests[0]).toMatchObject({ text: "えっ、本当に?", language: "Japanese" });

    // A "Japanese" line without kana is Chinese after all: translated instead.
    sink.prepare?.(voiceCtx, "苦力怕好討厭", "苦力怕真的很討厭");
    const second = sink.speak(voiceCtx, "苦力怕好討厭", null, null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await second).toBe("completed");
    expect(asked.length).toBe(1);
    expect(e.tts.requests[1]?.text).toBe("ja(?)");

    // Written in Japanese already: said as it is, no call.
    const third = sink.speak(voiceCtx, "もう、邪魔しないでよ!", null, null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await third).toBe("completed");
    expect(asked.length).toBe(1);
    expect(e.tts.requests[2]?.text).toBe("もう、邪魔しないでよ!");
  });

  it("speak_signal_abort_stops_playback", async () => {
    const e = await boot();
    e.tts.endless = true;
    const sink = e.h.services.require(VoiceSinkKey);
    const controller = new AbortController();
    const speaking = sink.speak(voiceCtx, "說很久", null, null, controller.signal);
    const start = await e.node.recvType("play_start");
    controller.abort(new Error("timed out"));
    expect(await speaking).toBe("interrupted");
    expect(await e.node.recvType("play_stop")).toEqual({
      type: "play_stop",
      play: start.play as number,
      fade_ms: 0,
    });
  });

  it("a line cut through the signal ends like a line cut off, with what was heard", async () => {
    const e = await boot();
    e.tts.endless = true;
    const events = e.h.subscribe(["voice.playback"]);
    const sink = e.h.services.require(VoiceSinkKey);
    const controller = new AbortController();
    const speaking = sink.speak(voiceCtx, "說很久", null, "t1", controller.signal);
    const start = await e.node.recvType("play_start");
    e.node.sendJson({ type: "playback", play: start.play as number, state: "started" });
    await sleepMs(80);
    controller.abort();
    expect(await speaking).toBe("interrupted");
    const states = [];
    for (;;) {
      const event = (await nextEvent(events)).event;
      if (event.type !== "voice_playback") continue;
      states.push(event.data.state);
      if (event.data.state === "started") continue;
      expect(event.data).toMatchObject({ text: "說很久", turn: "t1", total_ms: null });
      expect(event.data.heard_ms).toBeGreaterThanOrEqual(60);
      break;
    }
    expect(states).toEqual(["started", "interrupted"]);
  });

  it("how much was heard: the whole line, and a hold is nobody hearing anything", async () => {
    const e = await boot();
    const events = e.h.subscribe(["voice.playback"]);
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "短", null, "t2");
    const [play] = await readPlayback(e.node);
    finish(e.node, play);
    expect(await speaking).toBe("completed");
    for (;;) {
      const event = (await nextEvent(events)).event;
      if (event.type !== "voice_playback" || event.data.state !== "finished") continue;
      // 4800 samples at 24 kHz.
      expect(event.data.total_ms).toBe(200);
      break;
    }
  });

  it("her_lines_wait_while_a_song_holds_the_channel", async () => {
    const e = await boot();
    let holder: string | null = "song";
    e.h.services.provide("sing", VoiceFloorKey, { holder: (g) => (g === "g1" ? holder : null) });
    const sink = e.h.services.require(VoiceSinkKey);
    let outcome: string | null = null;
    const speaking = sink.speak(voiceCtx, "唱歌的時候說話", null, null).then((o) => {
      outcome = o;
      return o;
    });
    // Not dropped, not sent to TTS: it waits for the song to end.
    await sleepMs(600);
    expect(outcome).toBeNull();
    expect(e.tts.requests).toHaveLength(0);
    holder = null;
    const start = await e.node.recvType("play_start");
    e.node.sendJson({ type: "playback", play: start.play as number, state: "finished" });
    expect(await speaking).toBe("completed");
    expect(e.tts.requests).toHaveLength(1);
  });

  it("a line that waits too long for the floor is dropped and the drop is recorded", async () => {
    const e = await boot({ speech_hold_max_ms: 400 });
    e.h.services.provide("sing", VoiceFloorKey, { holder: () => "song" });
    const events = e.h.subscribe(["voice.barge_in"]);
    const sink = e.h.services.require(VoiceSinkKey);
    expect(await sink.speak(voiceCtx, "唱歌的時候說話", null, "turn-1")).toBe("interrupted");
    expect(e.tts.requests).toHaveLength(0);
    const ev = (await nextEvent(events)).event;
    expect(ev.type === "custom" && ev.data.payload).toEqual({
      context: voiceCtx,
      turn: "turn-1",
      account: null,
      action: "stop",
      reason: "floor",
    });
  });

  it("speech_pauses_while_the_song_worker_has_the_gpu", async () => {
    const e = await boot();
    let paused: string | null = "song";
    e.h.services.provide("sing", SpeechPauseKey, { paused: () => paused });
    const sink = e.h.services.require(VoiceSinkKey);
    // Her line is not sent to the (offloaded) TTS worker; it waits for the GPU to come back.
    const speaking = sink.speak(voiceCtx, "準備中說話", null, null);
    await sleepMs(400);
    expect(e.tts.requests).toHaveLength(0);
    paused = null;
    const start = await e.node.recvType("play_start");
    e.node.sendJson({ type: "playback", play: start.play as number, state: "finished" });
    expect(await speaking).toBe("completed");
    paused = "song";
    // What people say is dropped, not queued for later.
    e.speakStream(1, "u1", utteranceAudio());
    await new Promise((r) => setTimeout(r, 300));
    expect(e.asr.calls).toHaveLength(0);
    paused = null;
    const events = e.h.subscribe(["voice.utterance"]);
    e.speakStream(2, "u1", utteranceAudio());
    expect((await nextUtterance(events)).text).toBe("這個遊戲好難");
    expect(e.asr.calls).toHaveLength(1);
  });

  it("health_reports_a_missing_node", async () => {
    const e = await boot();
    expect(await e.module.health()).toEqual({ status: "healthy" });
    e.node.drop();
    await waitUntil(() => !e.h.link().isConnected());
    expect(await e.module.health()).toEqual({
      status: "degraded",
      reason: "voice node not connected",
    });
  });
});

// ------------------------------------------------------------- selective barge-in

/** A turn in flight in `voiceCtx` that is for `accounts`. */
function turnFor(...accounts: string[]): TurnFocus {
  return {
    turn: "turn-1",
    context: voiceCtx,
    reason: "addressed",
    phase: "speaking",
    addressed_by: accounts.map((a) => `h${a}`),
    addressed_accounts: accounts.map(account),
    focus: [],
    background: [],
    restarts: 0,
    started_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
  };
}

function provideFocus(e: Env, turn: TurnFocus | null): void {
  e.h.services.provide("agent", TurnFocusViewKey, {
    current: (context) => (context.channel === voiceCtx.channel ? turn : null),
    all: () => (turn === null ? [] : [turn]),
  });
}

interface Barge {
  action: string;
  reason: string;
  account: string | null;
}

/** The next `n` `voice.barge_in` records. */
async function nextBarges(sub: Subscription, n: number): Promise<Barge[]> {
  const out: Barge[] = [];
  while (out.length < n) {
    const ev = (await nextEvent(sub)).event;
    if (ev.type !== "custom") continue;
    const p = ev.data.payload as {
      action: string;
      reason: string;
      account: { id: string } | null;
    };
    out.push({ action: p.action, reason: p.reason, account: p.account?.id ?? null });
  }
  return out;
}

/** No utterance is published within `ms` (leaves a read pending on `sub`: use a fresh one after). */
async function expectNoUtterance(sub: Subscription, ms = 800): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const got = await Promise.race([sub.recv(), sleepMs(until - Date.now()).then(() => null)]);
    if (got === null) return;
    expect(got.event.type).not.toBe("voice_utterance");
  }
}

/** Starts a long line and returns once it plays. */
async function startLongLine(e: Env): Promise<{ id: number; speaking: Promise<string> }> {
  e.tts.endless = true;
  const sink = e.h.services.require(VoiceSinkKey);
  const speaking = sink.speak(voiceCtx, "我跟你說喔", null, "turn-1");
  // When the test ends the node goes away and the line fails: nobody needs to hear about it.
  speaking.catch(() => undefined);
  const start = await e.node.recvType("play_start");
  return { id: start.play as number, speaking };
}

describe("selective barge-in", () => {
  it("somebody the turn is not for only ducks her, then she gets her volume back", async () => {
    const e = await boot();
    provideFocus(e, turnFor("u2"));
    const events = e.h.subscribe(["voice.barge_in"]);
    const { id, speaking } = await startLongLine(e);
    let done = false;
    void speaking.then(
      () => {
        done = true;
      },
      () => undefined,
    );

    e.speakStream(9, "u1", utteranceAudio());
    expect(await e.node.recvType("play_duck")).toMatchObject({ play: id, gain: 0.3 });
    // ASR returns ordinary talk that does not call her: back to normal volume.
    expect(await e.node.recvType("play_duck")).toMatchObject({ play: id, gain: 1 });
    expect(done).toBe(false);
    expect(await nextBarges(events, 2)).toEqual([
      { action: "duck", reason: "other", account: "u1" },
      { action: "resume", reason: "other", account: "u1" },
    ]);
    // Nothing stopped or paused her meanwhile.
    expect(await e.node.collect(150)).toEqual([]);
  });

  it("the focus person pauses her, and a short reply lets her carry on", async () => {
    const e = await boot();
    provideFocus(e, turnFor("u1"));
    e.asr.text = "嗯";
    const events = e.h.subscribe(["voice.barge_in"]);
    const { id, speaking } = await startLongLine(e);
    let done = false;
    void speaking.then(
      () => {
        done = true;
      },
      () => undefined,
    );

    e.speakStream(9, "u1", utteranceAudio());
    expect(await e.node.recvType("play_duck")).toMatchObject({ play: id, gain: 0.3 });
    expect(await e.node.recvType("play_pause")).toMatchObject({ play: id });
    expect(await e.node.recvType("play_resume")).toMatchObject({ play: id });
    expect(done).toBe(false);
    // Her volume went down with the pause: the record says what her speech does, which is pause.
    const seen = await nextBarges(events, 2);
    expect(seen).toEqual([
      { action: "pause", reason: "focus", account: "u1" },
      { action: "resume", reason: "short_reply", account: "u1" },
    ]);
  });

  it("the focus person's real content stops her and the turn's later lines are not said", async () => {
    const e = await boot();
    provideFocus(e, turnFor("u1"));
    e.asr.text = "等一下我有話要跟你說";
    const events = e.h.subscribe(["voice.barge_in"]);
    const { id, speaking } = await startLongLine(e);
    const sink = e.h.services.require(VoiceSinkKey);

    e.speakStream(9, "u1", utteranceAudio());
    expect(await e.node.recvType("play_stop")).toMatchObject({ play: id, fade_ms: 150 });
    expect(await speaking).toBe("interrupted");
    expect(await nextBarges(events, 2)).toEqual([
      { action: "pause", reason: "focus", account: "u1" },
      { action: "stop", reason: "substantive", account: "u1" },
    ]);
    // The rest of that turn is dropped.
    expect(await sink.speak(voiceCtx, "還有下一句", null, "turn-1")).toBe("interrupted");
    expect(e.tts.requests).toHaveLength(1);
  });

  it("somebody saying her name stops her even when the turn is for someone else", async () => {
    const e = await boot({ names: ["小深"] });
    provideFocus(e, turnFor("u2"));
    e.asr.text = "小深你先別說了";
    const { id, speaking } = await startLongLine(e);
    e.speakStream(9, "u1", utteranceAudio());
    expect(await e.node.recvType("play_stop")).toMatchObject({ play: id });
    expect(await speaking).toBe("interrupted");
  });

  it("her own voice coming back through a microphone does not count and does not stop her", async () => {
    const e = await boot();
    provideFocus(e, turnFor("u1"));
    e.asr.text = "我跟你說喔";
    const utterances = e.h.subscribe(["voice.utterance"]);
    const { id, speaking } = await startLongLine(e);
    let done = false;
    void speaking.then(
      () => {
        done = true;
      },
      () => undefined,
    );
    e.speakStream(9, "u1", utteranceAudio());
    expect(await e.node.recvType("play_resume")).toMatchObject({ play: id });
    expect(done).toBe(false);
    await expectNoUtterance(utterances);
  });

  it("an ASR prompt echo does not count as speech", async () => {
    const e = await boot({ asr_prompt: "御坂10514號、DeepSeek醬、Miyo、米優" });
    e.asr.text = "御坂10514號、v(t) = Vm·sin(ωt + φ)、DeepSeek醬";
    const utterances = e.h.subscribe(["voice.utterance"]);
    e.speakStream(1, "u1", utteranceAudio());
    await waitUntil(() => e.asr.calls.length === 1);
    await expectNoUtterance(utterances);
  });

  it("without a turn focus she is only ducked, never stopped", async () => {
    const e = await boot();
    e.asr.text = "等一下我有話要跟你說";
    const { id, speaking } = await startLongLine(e);
    let done = false;
    void speaking.then(
      () => {
        done = true;
      },
      () => undefined,
    );
    e.speakStream(9, "u1", utteranceAudio());
    expect(await e.node.recvType("play_duck")).toMatchObject({ play: id, gain: 0.3 });
    expect(await e.node.recvType("play_duck")).toMatchObject({ play: id, gain: 1 });
    expect(done).toBe(false);
  });

  it("with an older node (no duck / pause) ducking does nothing and a pause is a stop", async () => {
    const e = await boot({}, null, []);
    provideFocus(e, turnFor("u1"));
    e.asr.text = "嗯";
    const { id, speaking } = await startLongLine(e);
    e.speakStream(9, "u1", utteranceAudio());
    expect(await e.node.recvType("play_stop")).toMatchObject({ play: id });
    expect(await speaking).toBe("interrupted");
  });

  it("people talking while a song plays are not heard unless they call her", async () => {
    const e = await boot({ names: ["小深"] });
    e.h.services.provide("sing", VoiceFloorKey, { holder: () => "song" });
    const utterances = e.h.subscribe(["voice.utterance"]);
    e.speakStream(1, "u1", utteranceAudio());
    await waitUntil(() => e.asr.calls.length === 1);
    await expectNoUtterance(utterances);
    e.asr.text = "小深幫我跳過這首";
    const later = e.h.subscribe(["voice.utterance"]);
    e.speakStream(2, "u1", utteranceAudio());
    expect((await nextUtterance(later)).text).toBe("小深幫我跳過這首");
  });
});

describe("TTS prefetch", () => {
  it("synthesizes the next line while the current one plays, and speaks it from the prefetch", async () => {
    const e = await boot();
    const sink = e.h.services.require(VoiceSinkKey);
    sink.prepare?.(voiceCtx, "第一句");
    const first = sink.speak(voiceCtx, "第一句", "happy", "turn-1");
    const p1 = await e.node.recvType("play_start");
    // The second line is queued behind the first: its TTS already ran.
    (sink as unknown as { prepare: (...a: unknown[]) => void }).prepare(
      voiceCtx,
      "第二句",
      undefined,
      "happy",
    );
    await waitUntil(() => e.tts.requests.length === 2);
    expect(e.tts.requests.map((r) => r.text)).toEqual(["第一句", "第二句"]);
    e.node.sendJson({ type: "playback", play: p1.play as number, state: "finished" });
    expect(await first).toBe("completed");

    const second = sink.speak(voiceCtx, "第二句", "happy", "turn-1");
    const p2 = await e.node.recvType("play_start");
    e.node.sendJson({ type: "playback", play: p2.play as number, state: "finished" });
    expect(await second).toBe("completed");
    // Spoken from the prefetch: no third request.
    expect(e.tts.requests).toHaveLength(2);
  });

  it("announces each line's subtitle before it plays: the first at once, the next before the first ends", async () => {
    // A lead longer than the lines: everything is announced as soon as it can be.
    const e = await boot({ subtitle_lead_ms: 5_000 });
    const upcoming = e.h.subscribe(["voice.upcoming"]);
    const sink = e.h.services.require(VoiceSinkKey);
    const texts = async () => {
      const env = await nextEvent(upcoming);
      const ev = env.event;
      return ev.type === "custom" ? (ev.data.payload as { text: string; turn: string }) : null;
    };
    sink.prepare?.(voiceCtx, "第一句", undefined, "happy");
    const first = sink.speak(voiceCtx, "第一句", "happy", "turn-1");
    expect(await texts()).toMatchObject({ text: "第一句", turn: "turn-1" });
    const p1 = await e.node.recvType("play_start");
    // Prepared while the first plays, inside its lead: announced at once, for the same turn.
    sink.prepare?.(voiceCtx, "第二句", undefined, "happy");
    expect(await texts()).toMatchObject({ text: "第二句", turn: "turn-1" });
    e.node.sendJson({ type: "playback", play: p1.play as number, state: "finished" });
    expect(await first).toBe("completed");
    const second = sink.speak(voiceCtx, "第二句", "happy", "turn-1");
    const p2 = await e.node.recvType("play_start");
    e.node.sendJson({ type: "playback", play: p2.play as number, state: "finished" });
    expect(await second).toBe("completed");
  });

  it("a lead of 0 announces nothing", async () => {
    const e = await boot({ subtitle_lead_ms: 0 });
    const upcoming = e.h.subscribe(["voice.upcoming"]);
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "安靜", "happy", "turn-1");
    const p = await e.node.recvType("play_start");
    e.node.sendJson({ type: "playback", play: p.play as number, state: "finished" });
    await speaking;
    expect(upcoming.tryRecv?.() ?? null).toBeNull();
  });

  describe("the line's tone", () => {
    const shown = (tag: string | null) =>
      ({
        snapshot: () => ({
          shown: tag === null ? null : { from: "joy", tag, style: "", masked: false },
        }),
      }) as unknown as AffectState;

    async function say(emotion: string | null, tag: string | null): Promise<TtsRequest> {
      const e = await boot();
      e.h.services.provide("app", AffectStateKey, shown(tag));
      const playback = e.h.subscribe(["voice.playback"]);
      const sink = e.h.services.require(VoiceSinkKey);
      const speaking = sink.speak(voiceCtx, "今天真好", emotion, null);
      const [id] = await readPlayback(e.node);
      e.node.sendJson({ type: "playback", play: id, state: "started" });
      e.node.sendJson({ type: "playback", play: id, state: "finished" });
      await speaking;
      const event = (await nextEvent(playback)).event;
      expect(event.type === "voice_playback" && event.data.emotion).toBe(emotion ?? tag);
      return e.tts.requests[0] as TtsRequest;
    }

    it("a line with no tag of its own is said the way she shows she feels", async () => {
      const req = await say(null, "annoyed");
      expect(req.emotion).toBe("annoyed");
      expect(req.instruct).toBe("不耐煩、拖長音");
    });

    it("her own tag wins over how she feels", async () => {
      expect((await say("happy", "annoyed")).emotion).toBe("happy");
      expect((await say("neutral", "annoyed")).emotion).toBe("neutral");
    });

    it("nothing standing out, and no Affect module, leaves it to the worker", async () => {
      expect((await say(null, null)).emotion).toBeNull();
    });

    it("a prepared line is synthesized in that tone, so it is not said twice", async () => {
      const e = await boot();
      e.h.services.provide("app", AffectStateKey, shown("sad"));
      const sink = e.h.services.require(VoiceSinkKey);
      sink.prepare?.(voiceCtx, "今天好累", undefined, null);
      await waitUntil(() => e.tts.requests.length === 1);
      const speaking = sink.speak(voiceCtx, "今天好累", null, null);
      const [id] = await readPlayback(e.node);
      e.node.sendJson({ type: "playback", play: id, state: "started" });
      e.node.sendJson({ type: "playback", play: id, state: "finished" });
      await speaking;
      expect(e.tts.requests).toHaveLength(1);
      expect(e.tts.requests[0]?.emotion).toBe("sad");
    });
  });

  it("does not prefetch when the emotion is not known, or when it is turned off", async () => {
    const e = await boot({ tts_prefetch: 0 });
    const sink = e.h.services.require(VoiceSinkKey);
    (sink as unknown as { prepare: (...a: unknown[]) => void }).prepare(
      voiceCtx,
      "第二句",
      undefined,
      "happy",
    );
    await sleepMs(100);
    expect(e.tts.requests).toHaveLength(0);
  });
});

// ------------------------------------------------------------- end-to-end latency

/** The next `voice.latency` payload of stage `e2e`. */
async function nextE2e(sub: Subscription): Promise<Record<string, JsonValue>> {
  for (;;) {
    const ev = (await nextEvent(sub)).event;
    if (ev.type !== "custom") continue;
    const p = ev.data.payload as Record<string, JsonValue>;
    if (p.stage === "e2e") return p;
  }
}

/** A turn in flight that answers the utterances `ids` (what the agent's focus view reports). */
function answering(turn: string, ...ids: string[]): TurnFocus {
  return {
    ...turnFor("u1"),
    turn,
    focus: ids.map((id) => ({ context: voiceCtx, id })),
  };
}

describe("end-to-end latency", () => {
  it("measures speech end to the first audio the node plays", async () => {
    const e = await boot();
    const events = e.h.subscribe(["voice.utterance", "voice.latency"]);
    e.speakStream(1, "u1", utteranceAudio());
    const u = await nextUtterance(events);
    provideFocus(e, answering("turn-1", u.id));
    const sink = e.h.services.require(VoiceSinkKey);
    sink.prepare?.(voiceCtx, "第一句", undefined, null);
    const speaking = sink.speak(voiceCtx, "第一句", null, "turn-1");
    const [id] = await readPlayback(e.node);
    e.node.sendJson({ type: "playback", play: id, state: "started" });
    e.node.sendJson({ type: "playback", play: id, state: "finished" });
    expect(await speaking).toBe("completed");

    const p = await nextE2e(events);
    expect(p.complete).toBe(true);
    expect(p.reason).toBeNull();
    expect(p.turn).toBe("turn-1");
    expect(p.utterance).toBe(u.id);
    const segments = p.segments as Record<string, number>;
    expect(Object.keys(segments)).toEqual([
      "endpoint",
      "asr",
      "llm_first",
      "tts_queue",
      "tts_first",
      "playback",
    ]);
    const sum = Object.values(segments).reduce((a, b) => a + b, 0);
    expect(sum).toBe(p.total_ms);
    // The silence after the speech is the endpoint: it cannot be shorter than the end silence.
    expect(segments.endpoint as number).toBeGreaterThanOrEqual(0);
    expect(p.unattributed_ms).toBe(0);
  });

  it("reports a TTS failure as incomplete", async () => {
    const e = await boot();
    const events = e.h.subscribe(["voice.utterance", "voice.latency"]);
    e.speakStream(1, "u1", utteranceAudio());
    const u = await nextUtterance(events);
    provideFocus(e, answering("turn-1", u.id));
    e.tts.failWith = "tts is down";
    const sink = e.h.services.require(VoiceSinkKey);
    await expect(sink.speak(voiceCtx, "第一句", null, "turn-1")).rejects.toThrow("tts is down");
    const p = await nextE2e(events);
    expect(p.complete).toBe(false);
    expect(p.reason).toBe("tts_failed");
    expect(p.total_ms).toBeNull();
    expect((p.segments as Record<string, number | null>).playback).toBeNull();
  });

  it("does not count a turn she started herself", async () => {
    const e = await boot();
    const events = e.h.subscribe(["voice.utterance", "voice.latency"]);
    e.speakStream(1, "u1", utteranceAudio());
    await nextUtterance(events);
    provideFocus(e, answering("turn-self")); // no focus: nobody spoke to her
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "我自己想說", null, "turn-self");
    const [id] = await readPlayback(e.node);
    finish(e.node, id);
    expect(await speaking).toBe("completed");
    await sleepMs(100);
    let seen = 0;
    for (;;) {
      const env = await Promise.race([events.recv(), sleepMs(50).then(() => "idle" as const)]);
      if (env === "idle" || env === null) break;
      const ev = env.event;
      if (ev.type === "custom" && (ev.data.payload as { stage?: string }).stage === "e2e") seen++;
    }
    expect(seen).toBe(0);
  });
});

// ------------------------------------------------------------------- end of turn

/** The end-of-turn worker: answers `POST /turn` with what `answers` holds, in order. */
class TurnWorker {
  readonly asked: number[] = [];
  readonly #server: Server;
  answers: Array<{ complete: boolean; probability: number }> = [];

  constructor() {
    this.#server = createServer((req, res) => {
      let bytes = 0;
      req.on("data", (d: Buffer) => {
        bytes += d.length;
      });
      req.on("end", () => {
        this.asked.push(bytes);
        const answer = this.answers.shift() ?? { complete: true, probability: 0.9 };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ...answer, inference_ms: 1 }));
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.#server.close(resolve));
  }
}

function open(e: Env, stream: number, user: string): void {
  e.node.sendJson({
    type: "stream_open",
    stream,
    guild: "g1",
    channel: "vc1",
    user_id: user,
    display_name: `nick-${user}`,
    sample_rate: 16000,
  });
}

describe("end of turn", () => {
  let worker: TurnWorker | null = null;

  afterEach(async () => {
    await env?.h.stop();
    env = null;
    await worker?.stop();
    worker = null;
  });

  async function bootTurn(config: JsonObject = {}): Promise<Env> {
    worker = new TurnWorker();
    const url = await worker.start();
    return boot({ turn_engine: "smart-turn", turn_url: url, turn_stop_ms: 100, ...config });
  }

  it("answers without waiting for the node to close the stream", async () => {
    const e = await bootTurn();
    const events = e.h.subscribe(["voice.utterance"]);
    open(e, 1, "u1");
    e.node.sendAudio(1, utteranceAudio());
    const u = await nextUtterance(events);
    expect(u.turn).toEqual({ ended_by: "turn", probability: 0.9 });
    expect(worker?.asked).toHaveLength(1);
    expect(worker?.asked[0] as number).toBeGreaterThan(0);
    expect(e.asr.calls).toHaveLength(1);
  });

  it("measures silence on the clock: the node sends nothing while nobody talks", async () => {
    const e = await bootTurn();
    const events = e.h.subscribe(["voice.utterance"]);
    open(e, 1, "u1");
    e.node.sendAudio(1, voice(1200)); // No silence after it, and the stream stays open.
    const u = await nextUtterance(events);
    expect(u.turn?.ended_by).toBe("turn");
  });

  it("keeps a sentence with a pause in one piece, over the stream closing in between", async () => {
    const e = await bootTurn({ turn_max_silence_ms: 3_000 });
    (worker as TurnWorker).answers = [{ complete: false, probability: 0.1 }];
    const events = e.h.subscribe(["voice.utterance"]);
    open(e, 1, "u1");
    e.node.sendAudio(1, voice(800));
    e.node.sendJson({ type: "stream_close", stream: 1 });
    await waitUntil(() => worker?.asked.length === 1);
    await sleepMs(200);
    expect(e.asr.calls).toHaveLength(0);
    open(e, 2, "u1");
    e.node.sendAudio(2, voice(800));
    e.node.sendJson({ type: "stream_close", stream: 2 });
    const u = await nextUtterance(events);
    expect(u.turn?.ended_by).toBe("turn");
    expect(e.asr.calls).toHaveLength(1);
    // Both halves, and the pause between them.
    expect(e.asr.calls[0]?.[0] as number).toBeGreaterThan(1_500 * 16);
  });

  it("ends the turn at the timeout when the model never says it is over", async () => {
    const e = await bootTurn({ turn_max_silence_ms: 400 });
    (worker as TurnWorker).answers = [{ complete: false, probability: 0.2 }];
    const events = e.h.subscribe(["voice.utterance"]);
    open(e, 1, "u1");
    e.node.sendAudio(1, voice(800));
    e.node.sendJson({ type: "stream_close", stream: 1 });
    const u = await nextUtterance(events);
    expect(u.turn).toEqual({ ended_by: "timeout", probability: 0.2 });
  });

  it("falls back to the silence when the worker is not there", async () => {
    const e = await boot({
      turn_engine: "smart-turn",
      turn_url: "http://127.0.0.1:9",
      turn_stop_ms: 100,
      end_silence_ms: 300,
    });
    const events = e.h.subscribe(["voice.utterance"]);
    e.speakStream(1, "u1", utteranceAudio());
    const u = await nextUtterance(events);
    expect(u.turn?.ended_by).toBe("silence");
    expect(u.text).toBe("這個遊戲好難");
  });

  it("transcribes ahead when told to, and uses that transcript at the timeout", async () => {
    const e = await bootTurn({ turn_max_silence_ms: 500, turn_early_asr: true });
    (worker as TurnWorker).answers = [{ complete: false, probability: 0.2 }];
    const events = e.h.subscribe(["voice.utterance"]);
    open(e, 1, "u1");
    e.node.sendAudio(1, voice(800));
    await waitUntil(() => e.asr.calls.length === 1);
    const u = await nextUtterance(events);
    expect(u.turn?.ended_by).toBe("timeout");
    expect(e.asr.calls).toHaveLength(1);
  });

  it("drops the transcript made ahead when the speaker goes on", async () => {
    const e = await bootTurn({ turn_max_silence_ms: 3_000, turn_early_asr: true });
    (worker as TurnWorker).answers = [{ complete: false, probability: 0.2 }];
    const events = e.h.subscribe(["voice.utterance"]);
    open(e, 1, "u1");
    e.node.sendAudio(1, voice(800));
    await waitUntil(() => e.asr.calls.length === 1);
    e.node.sendAudio(1, voice(800));
    const u = await nextUtterance(events);
    expect(u.turn?.ended_by).toBe("turn");
    expect(e.asr.calls).toHaveLength(2);
    expect(e.asr.calls[1]?.[0] as number).toBeGreaterThan(e.asr.calls[0]?.[0] as number);
  });

  it("does not transcribe ahead by default", async () => {
    const e = await bootTurn({ turn_max_silence_ms: 3_000 });
    (worker as TurnWorker).answers = [{ complete: false, probability: 0.2 }];
    open(e, 1, "u1");
    e.node.sendAudio(1, voice(800));
    await waitUntil(() => worker?.asked.length === 1);
    await sleepMs(100);
    expect(e.asr.calls).toHaveLength(0);
  });

  it("does not start her reply while the person it answers talks on", async () => {
    const e = await bootTurn({ turn_confirm_ms: 100, turn_gate_max_ms: 5_000 });
    provideFocus(e, turnFor("u1"));
    open(e, 1, "u1");
    e.node.sendAudio(1, voice(800));
    await sleepMs(50); // The frames are there.
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "我覺得", null, "turn-1");
    await sleepMs(50);
    expect(e.tts.requests).toHaveLength(0);
    const [id] = await readPlayback(e.node);
    expect(e.tts.requests).toHaveLength(1);
    finish(e.node, id);
    expect(await speaking).toBe("completed");
  });

  it("does not make anyone wait without a model", async () => {
    const e = await boot();
    provideFocus(e, turnFor("u1"));
    open(e, 1, "u1");
    e.node.sendAudio(1, voice(800));
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "我覺得", null, "turn-1");
    const [id] = await readPlayback(e.node);
    finish(e.node, id);
    expect(await speaking).toBe("completed");
  });

  it("says in the latency record how the turn ended", async () => {
    const e = await bootTurn();
    const events = e.h.subscribe(["voice.utterance", "voice.latency"]);
    e.speakStream(1, "u1", utteranceAudio());
    const u = await nextUtterance(events);
    provideFocus(e, answering("turn-1", u.id));
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "第一句", null, "turn-1");
    const [id] = await readPlayback(e.node);
    e.node.sendJson({ type: "playback", play: id, state: "started" });
    e.node.sendJson({ type: "playback", play: id, state: "finished" });
    await speaking;
    const p = await nextE2e(events);
    expect(p.complete).toBe(true);
    expect(p.turn_end).toEqual({ ended_by: "turn", probability: 0.9 });
    const sum = Object.values(p.segments as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBe(p.total_ms);
  });

  it("publishes every answer of the model, for calibration", async () => {
    const e = await bootTurn();
    const events = e.h.subscribe(["voice.latency"]);
    e.speakStream(1, "u1", utteranceAudio());
    for (;;) {
      const ev = (await nextEvent(events)).event;
      if (ev.type !== "custom") continue;
      const p = ev.data.payload as Record<string, JsonValue>;
      if (p.stage !== "turn") continue;
      expect(p.verdict).toBe("complete");
      expect(p.probability).toBe(0.9);
      break;
    }
  });
});

describe("what the speaker sends the worker", () => {
  it("marks the line she needs now and the ones for later", async () => {
    const e = await boot();
    const sink = e.h.services.require(VoiceSinkKey);
    const prepare = (sink as unknown as { prepare: (...a: unknown[]) => void }).prepare.bind(sink);
    prepare(voiceCtx, "第一句", undefined, "happy");
    prepare(voiceCtx, "第二句", undefined, "happy");
    await waitUntil(() => e.tts.requests.length === 2);
    expect(e.tts.requests.map((r) => r.priority)).toEqual(["now", "ahead"]);
  });

  it("counts the worker's queue as queue, not as synthesis", async () => {
    const e = await boot();
    e.tts.queueMs = 40;
    const events = e.h.subscribe(["voice.utterance", "voice.latency"]);
    e.speakStream(1, "u1", utteranceAudio());
    const u = await nextUtterance(events);
    provideFocus(e, answering("turn-1", u.id));
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "第一句", null, "turn-1");
    const [id] = await readPlayback(e.node);
    e.node.sendJson({ type: "playback", play: id, state: "started" });
    e.node.sendJson({ type: "playback", play: id, state: "finished" });
    await speaking;
    const segments = (await nextE2e(events)).segments as Record<string, number>;
    expect(segments.tts_queue as number).toBeGreaterThanOrEqual(40);
  });
});

describe("what ASR hears", () => {
  it("puts a misheard name right before anything reads the transcript", async () => {
    const e = await boot({ asr_aliases: { 咪o: "Miyo" } });
    e.asr.text = "咪o 你在嗎";
    const events = e.h.subscribe(["voice.utterance"]);
    e.speakStream(1, "u1", utteranceAudio());
    expect((await nextUtterance(events)).text).toBe("Miyo 你在嗎");
  });

  it("the end of speech is when the frames stopped, not when the stream closed", async () => {
    const e = await boot({ end_silence_ms: 5_000 });
    const events = e.h.subscribe(["voice.utterance"]);
    open(e, 1, "u1");
    e.node.sendAudio(1, voice(1000));
    await sleepMs(300); // SILENCE_MS on the node: frames stopped, the stream is still open.
    e.node.sendJson({ type: "stream_close", stream: 1 });
    const u = await nextUtterance(events);
    expect(u.asr_ms).toBeGreaterThanOrEqual(250);
  });

  it("goes on listening while a song has the GPU when told to", async () => {
    const e = await boot({ asr_while_paused: true });
    e.h.services.provide("sing", SpeechPauseKey, { paused: () => "song" });
    const events = e.h.subscribe(["voice.utterance"]);
    e.speakStream(1, "u1", utteranceAudio());
    expect((await nextUtterance(events)).text).toBe("這個遊戲好難");
  });
});

describe("the last stop before a voice", () => {
  /** Blocks whatever holds `word`, and remembers what it was asked. */
  function review(e: Env, word = "禁語"): OutputCheck[] {
    const asked: OutputCheck[] = [];
    const service = {
      filteredLine: "Filtered.",
      filteredVoiceLine: "嗶。",
      screen: (check: OutputCheck) => {
        asked.push(check);
        const hit = check.voice?.includes(word) === true;
        return {
          ok: !hit,
          visible: null,
          voice: hit ? "嗶。" : (check.voice ?? null),
          blocked: hit
            ? [{ field: "voice", category: "custom", rule: "test.word", layer: "rules" }]
            : [],
        };
      },
    } as unknown as ModerationService;
    e.h.services.provide("app", ModerationKey, service);
    return asked;
  }

  const translated = (reply: string) =>
    ({ complete: async () => ({ text: reply }) }) as unknown as Pick<LlmRouter, "complete">;

  it("the text is reviewed before it is translated: what is blocked is not sent anywhere", async () => {
    const e = await boot({ tts_translate: "ja" }, {
      complete: async () => {
        throw new Error("a blocked line must not be translated");
      },
    } as unknown as Pick<LlmRouter, "complete">);
    const asked = review(e);
    const events = e.h.subscribe(["voice.playback"]);
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "那個禁語", null, "t1");
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await speaking).toBe("completed");
    expect(e.tts.requests.map((r) => r.text)).toEqual(["嗶。"]);
    expect(asked[0]).toMatchObject({ path: "tts", turn: "t1" });
    // Subtitles and her history follow this event: the words are gone from there too.
    const first = (await nextEvent(events)).event;
    expect(first).toMatchObject({ data: { state: "started", text: "嗶。", blocked: "test.word" } });
  });

  it("the translation is reviewed on its own: it can say what its source did not", async () => {
    const e = await boot({ tts_translate: "ja" }, translated("禁語です"));
    const asked = review(e);
    const events = e.h.subscribe(["voice.playback"]);
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "沒問題的句子", null, "t1");
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await speaking).toBe("completed");
    expect(e.tts.requests.map((r) => r.text)).toEqual(["嗶。"]);
    expect(asked.map((a) => a.path)).toEqual(["tts", "tts", "translation"]);
    // The written line was fine: the subtitle stays, and the ledger still hears it was not said.
    const first = (await nextEvent(events)).event;
    expect(first).toMatchObject({
      data: { state: "started", text: "沒問題的句子", blocked: "test.word" },
    });
  });

  it("a line synthesized ahead is reviewed as well", async () => {
    const e = await boot({ tts_prefetch: 2 });
    review(e);
    const sink = e.h.services.require(VoiceSinkKey);
    sink.prepare?.(voiceCtx, "那個禁語", undefined, null);
    await waitUntil(() => e.tts.requests.length === 1);
    expect(e.tts.requests[0]?.text).toBe("嗶。");
  });

  it("a line the turn already replaced is reported as blocked", async () => {
    const e = await boot();
    review(e);
    const events = e.h.subscribe(["voice.playback"]);
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "Filtered.", null, "t1");
    finish(e.node, (await readPlayback(e.node))[0]);
    await speaking;
    expect((await nextEvent(events)).event).toMatchObject({ data: { blocked: "Filtered." } });
  });

  it("without the service she speaks as she always did", async () => {
    const e = await boot();
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "那個禁語", null, null);
    finish(e.node, (await readPlayback(e.node))[0]);
    expect(await speaking).toBe("completed");
    expect(e.tts.requests[0]?.text).toBe("那個禁語");
  });
});

describe("the emergency stop", () => {
  it("`silence` stops what plays, even a line that came without the scheduler", async () => {
    const e = await boot();
    e.tts.endless = true;
    const sink = e.h.services.require(VoiceSinkKey);
    const speaking = sink.speak(voiceCtx, "說很久", null, null);
    const start = await e.node.recvType("play_start");
    sink.silence?.();
    expect(await e.node.recvType("play_stop")).toMatchObject({ play: start.play, fade_ms: 0 });
    expect(await speaking).toBe("interrupted");
  });

  it("while it is on, nothing is synthesized or played", async () => {
    const e = await boot({ tts_prefetch: 2 });
    e.h.services.provide("app", ActuatorExecutorKey, {
      paused: true,
      run: async () => "",
      dropped: () => undefined,
    });
    const sink = e.h.services.require(VoiceSinkKey);
    sink.prepare?.(voiceCtx, "想說的話", undefined, null);
    expect(await sink.speak(voiceCtx, "想說的話", null, null)).toBe("interrupted");
    expect(e.tts.requests).toEqual([]);
  });
});
