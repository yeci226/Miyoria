// Unit tests of the protocol, VAD, segmentation, text, consent, barge-in and config helpers.

import { MemorySettingsStore, type SettingsStore } from "@miyoria/store";
import { type AccountRef, EMOTION_NAMES, EMOTION_OUTPUTS, type JsonObject } from "@miyoria/types";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import type { AsrHint, SpeechService } from "../../speech/src/index.js";
import {
  BargeIn,
  Consent,
  cleanTranscript,
  coreMessageJson,
  decodeAudio,
  EnergyVad,
  echoesHint,
  encodeAudio,
  energyDb,
  Hearing,
  isHallucination,
  NodeMessageSchema,
  Segmenter,
  Semaphore,
  type Stoppable,
  stripEmoji,
  stripTags,
  TAG_PLAYBACK,
  toTraditional,
  type Utterance,
  VoiceConfigSchema,
  VoiceProfile,
  zeroCrossingRate,
} from "../src/index.js";
import { deepseekVoice } from "./harness.js";
import { chunks, concat, mix, noise, RATE, silence, tone, voice } from "./synth.js";

// ----------------------------------------------------------------- protocol

describe("protocol", () => {
  it("audio_frames_round_trip", () => {
    const frame = encodeAudio(TAG_PLAYBACK, 7, Int16Array.of(1, -2, 32767, -32768));
    expect(frame[0]).toBe(0x02);
    expect([...frame.subarray(1, 5)]).toEqual([7, 0, 0, 0]);
    const d = decodeAudio(frame);
    expect(d?.tag).toBe(TAG_PLAYBACK);
    expect(d?.id).toBe(7);
    expect([...(d?.samples ?? [])]).toEqual([1, -2, 32767, -32768]);
    expect(decodeAudio(Uint8Array.of(1, 2, 3))).toBeNull();
  });

  it("messages_match_the_spec", () => {
    const hello = NodeMessageSchema.parse(
      JSON.parse(
        '{"type":"hello","version":1,"token":"t","node":"voice-node","self_account":{"platform":"discord","id":"42"}}',
      ),
    );
    expect(hello.type === "hello" && hello.version).toBe(1);
    const pb = NodeMessageSchema.parse(
      JSON.parse('{"type":"playback","play":3,"state":"finished"}'),
    );
    expect(pb).toEqual({ type: "playback", play: 3, state: "finished", error: null });
    expect(coreMessageJson({ type: "join", guild: "g", user_id: "u" })).toBe(
      '{"type":"join","guild":"g","user_id":"u"}',
    );
    expect(coreMessageJson({ type: "play_stop", play: 1, fade_ms: 80 })).toBe(
      '{"type":"play_stop","play":1,"fade_ms":80}',
    );
  });

  it("golive_messages_match_the_spec", () => {
    expect(
      coreMessageJson({
        type: "golive_start",
        guild: "g",
        channel: undefined,
        source: "srt://127.0.0.1:9999",
        width: undefined,
        height: 1080,
        fps: 60,
        bitrate_kbps: undefined,
        encoder: "nvenc",
        audio: undefined,
        listen: undefined,
      }),
    ).toBe(
      '{"type":"golive_start","guild":"g","source":"srt://127.0.0.1:9999","height":1080,"fps":60,"encoder":"nvenc"}',
    );
    expect(coreMessageJson({ type: "golive_stop", guild: "g" })).toBe(
      '{"type":"golive_stop","guild":"g"}',
    );
    expect(NodeMessageSchema.parse({ type: "golive", guild: "g", state: "live" })).toEqual({
      type: "golive",
      guild: "g",
      state: "live",
      error: null,
      reason: null,
    });
    const failed = NodeMessageSchema.parse({
      type: "golive",
      guild: "g",
      state: "failed",
      error: "ffmpeg not found",
    });
    expect(failed.type === "golive" && failed.state === "failed" && failed.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------- vad

function speechFrames(vad: EnergyVad, audio: Int16Array): number {
  let count = 0;
  for (let at = 0; at + vad.frameLen <= audio.length; at += vad.frameLen) {
    if (vad.isSpeech(audio.subarray(at, at + vad.frameLen))) count++;
  }
  return count;
}

describe("vad", () => {
  it("levels", () => {
    expect(energyDb(silence(20))).toBe(-100);
    const full = energyDb(tone(20, 400, 1));
    expect(Math.abs(full - -3)).toBeLessThan(0.5);
    const zcr = zeroCrossingRate(tone(100, 400, 0.5));
    expect(Math.abs(zcr - 0.05)).toBeLessThan(0.01);
    expect(zeroCrossingRate(noise(100, 0.3, 1))).toBeGreaterThan(0.4);
  });

  it("silence_and_quiet_audio_are_not_speech", () => {
    const vad = new EnergyVad();
    expect(speechFrames(vad, silence(1000))).toBe(0);
    // -66 dBFS hiss.
    expect(speechFrames(vad, noise(1000, 0.001, 2))).toBe(0);
  });

  it("voice_is_speech", () => {
    expect(speechFrames(new EnergyVad(), voice(1000, 0.3))).toBeGreaterThanOrEqual(45);
  });

  it("white_noise_is_rejected", () => {
    // About -35 dBFS: louder than the floor, but broadband.
    expect(speechFrames(new EnergyVad(), noise(2000, 0.03, 3))).toBe(0);
  });

  it("voice_over_noise_is_detected", () => {
    const vad = new EnergyVad();
    speechFrames(vad, noise(4000, 0.01, 4));
    const mixed = mix(voice(1000, 0.3), noise(1000, 0.01, 5));
    expect(speechFrames(vad, mixed)).toBeGreaterThanOrEqual(40);
  });

  it("steady_hum_adapts_away", () => {
    const vad = new EnergyVad();
    // A constant 100 Hz hum: speech-like at first, noise once the floor window has seen it.
    const hum = tone(8000, 100, 0.05);
    const late: boolean[] = [];
    let i = 0;
    for (let at = 0; at + vad.frameLen <= hum.length; at += vad.frameLen, i++) {
      const s = vad.isSpeech(hum.subarray(at, at + vad.frameLen));
      if (i >= 200) late.push(s);
    }
    expect(late.every((s) => !s)).toBe(true);
    expect(vad.noiseFloorDb()).toBeGreaterThan(-40);
    // Real speech on top of the hum still counts.
    const frames = speechFrames(vad, mix(voice(1000, 0.4), tone(1000, 100, 0.05)));
    expect(frames).toBeGreaterThanOrEqual(20);
  });
});

// ------------------------------------------------------------------ segment

function seg(config = {}): Segmenter<EnergyVad> {
  return new Segmenter(new EnergyVad(), config);
}

/** 20 ms network frames, like the voice node sends. */
function feed(s: Segmenter, audio: Int16Array): Utterance[] {
  const out: Utterance[] = [];
  for (const c of chunks(audio, 320)) out.push(...s.push(c));
  return out;
}

const msOf = (u: Utterance) => Math.floor((u.samples.length * 1000) / RATE);

describe("segment", () => {
  it("silence_produces_nothing", () => {
    const s = seg();
    expect(feed(s, silence(3000))).toEqual([]);
    expect(s.finish()).toBeNull();
  });

  it("speech_then_silence_ends_an_utterance", () => {
    const s = seg();
    const out = feed(s, concat(silence(500), voice(1200, 0.3), silence(1000)));
    expect(out.length).toBe(1);
    const u = out[0] as Utterance;
    expect(u.speechMs).toBeGreaterThanOrEqual(1200);
    expect(u.speechMs).toBeLessThanOrEqual(1500);
    expect(u.voicedMs).toBeGreaterThanOrEqual(900);
    expect(u.trailingSilenceMs).toBeGreaterThanOrEqual(600);
    expect(u.endedBy).toBe("silence");
    // Pre-roll + speech + tail.
    expect(msOf(u)).toBeGreaterThanOrEqual(1300);
    expect(msOf(u)).toBeLessThanOrEqual(1800);
    expect(s.isActive()).toBe(false);
    expect(s.finish()).toBeNull();
  });

  it("short_pauses_do_not_split", () => {
    const s = seg();
    const out = feed(s, concat(voice(800, 0.3), silence(300), voice(800, 0.3), silence(800)));
    expect(out.length).toBe(1);
    expect(out[0]?.speechMs).toBeGreaterThanOrEqual(1800);
  });

  it("two_utterances", () => {
    const s = seg();
    const audio = concat(voice(700, 0.3), silence(900), tone(600, 220, 0.2), silence(900));
    expect(feed(s, audio).length).toBe(2);
  });

  it("short_bursts_are_dropped", () => {
    const s = seg();
    const parts: Int16Array[] = [];
    for (let i = 0; i < 5; i++) parts.push(tone(100, 300, 0.3), silence(800));
    expect(feed(s, concat(...parts))).toEqual([]);
    // A single loud click frame.
    expect(feed(s, concat(silence(200), tone(20, 300, 0.9), silence(1000)))).toEqual([]);
  });

  it("noise_is_dropped", () => {
    const s = seg();
    expect(feed(s, noise(5000, 0.03, 9))).toEqual([]);
    expect(s.finish()).toBeNull();
  });

  it("speech_in_background_noise", () => {
    const s = seg();
    const audio = concat(
      noise(3000, 0.01, 10),
      mix(voice(1500, 0.3), noise(1500, 0.01, 11)),
      noise(1500, 0.01, 12),
    );
    const out = feed(s, audio);
    expect(out.length).toBe(1);
    expect(out[0]?.speechMs).toBeGreaterThanOrEqual(1300);
  });

  it("long_speech_is_cut_at_max", () => {
    const s = seg({ maxUtteranceMs: 2000 });
    const out = feed(s, voice(5000, 0.3));
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const u of out) expect(msOf(u)).toBeLessThanOrEqual(2000);
    expect(out[0]?.endedBy).toBe("length");
  });

  it("stream_close_flushes", () => {
    const s = seg();
    expect(feed(s, voice(900, 0.3))).toEqual([]);
    expect(s.isActive()).toBe(true);
    const u = s.finish();
    expect(u?.speechMs).toBeGreaterThanOrEqual(850);
    expect(u?.endedBy).toBe("close");
    expect(s.isActive()).toBe(false);
    // Too short to keep.
    feed(s, voice(150, 0.3));
    expect(s.finish()).toBeNull();
  });

  it("speech_run_tracks_continuous_talk", () => {
    const s = seg();
    feed(s, voice(700, 0.3));
    expect(s.speechRunMs()).toBeGreaterThanOrEqual(600);
    feed(s, silence(400));
    expect(s.speechRunMs()).toBe(0);
  });
});

// --------------------------------------------------------------------- text

describe("text", () => {
  it("converts_to_taiwan_traditional", () => {
    expect(toTraditional("你好,这个软件很好用")).toBe("你好,這個軟體很好用");
    expect(toTraditional("早安")).toBe("早安");
    expect(toTraditional("hello 123")).toBe("hello 123");
  });

  it("detects_hallucinations", () => {
    for (const h of [
      "谢谢观看",
      "謝謝觀看!",
      "字幕由Amara.org社区提供",
      "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
      "Thank you for watching.",
      "。。。",
    ]) {
      expect(isHallucination(h, []), h).toBe(true);
    }
    for (const ok of ["謝謝你", "我看了字幕", "今天要做什麼?", "thank you"]) {
      expect(isHallucination(ok, []), ok).toBe(false);
    }
    expect(isHallucination("嗯嗯请关注频道", ["關注頻道"])).toBe(true);
  });

  it("drops_transcripts_that_only_repeat_the_asr_hint", () => {
    const prompt =
      "Miyo、Miyoria、米優、DeepSeek、Minecraft、麥塊、Baritone、鑽石、苦力怕、Discord、直播 Brian0901、IMR、Aquatf";
    expect(
      echoesHint(
        "米優、米優、DeepSeek、Minecraft、麥塊、Baritone、鑽石、苦力怕、Discord、直播 Brian0901、IMR、小黃",
        prompt,
      ),
    ).toBe(true);
    expect(echoesHint("Miyo,你覺得 Minecraft 好玩嗎?", prompt)).toBe(false);
    expect(echoesHint("米優、米優", prompt)).toBe(false);
    expect(echoesHint("我們來玩 Minecraft 還是 Discord 聊天", prompt)).toBe(false);
    expect(echoesHint("米優、DeepSeek、Minecraft", null)).toBe(false);
  });

  it("cleans_transcripts", () => {
    expect(cleanTranscript("  这个  游戏 ", true, [])).toBe("這個 遊戲");
    expect(cleanTranscript("这个", false, [])).toBe("这个");
    expect(cleanTranscript("", true, [])).toBeNull();
    expect(cleanTranscript("……?!", true, [])).toBeNull();
    expect(cleanTranscript("谢谢观看", true, [])).toBeNull();
  });

  it("strips_expression_tags", () => {
    expect(stripTags("<emo:happy>欸你回來啦!<pause 300/>今天怎樣?<silence/>")).toBe(
      "欸你回來啦! 今天怎樣?",
    );
    expect(stripTags("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
    expect(stripTags("<3 你")).toBe("<3 你");
    expect(stripTags("<emo:smug")).toBe("<emo:smug");
    expect(stripTags("<<emo:sad>>")).toBe("< >");
  });

  it("strips_emoji_and_server_emoji_shortcodes", () => {
    expect(stripEmoji("好餓 🍚 :fanfan: 給我")).toBe("好餓 給我");
    expect(stripEmoji("讚👍🏻!❤️")).toBe("讚 !");
    expect(stripEmoji("👨‍👩‍👧")).toBe("");
    expect(stripEmoji("現在 12:30:45")).toBe("現在 12:30:45");
  });

  it("strips_sticker_tokens", () => {
    expect(stripEmoji("謝啦 [貼圖: 貓咪鞠躬] 掰")).toBe("謝啦 掰");
    expect(stripEmoji("[貼圖：spin]")).toBe("");
    expect(stripEmoji("[sticker: Wave] ok")).toBe("ok");
    expect(stripEmoji("[圖片: a.png] 看")).toBe("[圖片: a.png] 看");
  });
});

// ------------------------------------------------------------------ consent

function acc(id: string): AccountRef {
  return { platform: "discord", id };
}

describe("consent", () => {
  it("opt_out_by_default", async () => {
    const store: SettingsStore = new MemorySettingsStore();
    const c = new Consent("opt-out", store);
    expect(await c.allowed(acc("1"))).toBe(true);
    await c.set(acc("1"), false);
    expect(await c.allowed(acc("1"))).toBe(false);
    expect(await c.allowed(acc("2"))).toBe(true);
    expect(await store.get("_global", "voice_consent:discord:1")).toBe(false);
    // A fresh instance reads the stored flag.
    expect(await new Consent("opt-out", store).allowed(acc("1"))).toBe(false);
  });

  it("opt_in_and_memory_only", async () => {
    const c = new Consent("opt-in", null);
    expect(await c.allowed(acc("1"))).toBe(false);
    await c.set(acc("1"), true);
    expect(await c.allowed(acc("1"))).toBe(true);
    expect(await c.allowed(acc("2"))).toBe(false);
  });

  it("store_errors_fail_closed_and_cache_expires", async () => {
    let now = 0;
    const store = new MemorySettingsStore();
    const c = new Consent("opt-out", store, { now: () => now });
    expect(await c.allowed(acc("1"))).toBe(true);
    await store.set("_global", "voice_consent:discord:1", false);
    expect(await c.allowed(acc("1"))).toBe(true); // cached
    now = 61_000;
    expect(await c.allowed(acc("1"))).toBe(false);
    const broken: SettingsStore = {
      get: () => Promise.reject(new Error("db down")),
      set: () => Promise.resolve(),
      list: () => Promise.resolve(new Map()),
      deletePrefix: () => Promise.resolve(0),
    };
    expect(await new Consent("opt-out", broken).allowed(acc("1"))).toBe(false);
  });
});

// -------------------------------------------------------------------- barge

class FakePlayback implements Stoppable {
  stops = 0;
  fade = -1;

  stop(fadeMs: number): void {
    this.stops++;
    this.fade = fadeMs;
  }
}

describe("barge", () => {
  it("stops_after_threshold_once", () => {
    const b = new BargeIn("stop", 600, 120);
    const p = new FakePlayback();
    expect(b.observe("g", 1000)).toBe(false); // nothing playing
    const token = b.register("g", p);
    expect(b.observe("g", 400)).toBe(false);
    expect(b.observe("other", 900)).toBe(false);
    expect(b.observe("g", 620)).toBe(true);
    expect(b.observe("g", 900)).toBe(false); // only once
    expect(p.stops).toBe(1);
    expect(p.fade).toBe(120);
    b.unregister("g", token);
    expect(b.observe("g", 900)).toBe(false);
  });

  it("ignore_mode_never_stops", () => {
    const b = new BargeIn("ignore", 600, 120);
    const p = new FakePlayback();
    b.register("g", p);
    expect(b.observe("g", 5000)).toBe(false);
    expect(p.stops).toBe(0);
  });

  it("stale_unregister_keeps_newer_playback", () => {
    const b = new BargeIn("stop", 600, 0);
    const old = b.register("g", new FakePlayback());
    const p = new FakePlayback();
    b.register("g", p);
    b.unregister("g", old);
    expect(b.observe("g", 700)).toBe(true);
    expect(p.stops).toBe(1);
  });
});

// ------------------------------------------------------------------- config

describe("config", () => {
  it("parses_the_deepseek_chan_voice", () => {
    const p = VoiceProfile.parse("deepseek-chan", deepseekVoice());
    expect(p.provider).toBe("qwen3-tts");
    expect(p.voice).toBe("deepseek-chan");
    expect(p.cloned).toBe(true);
    expect(p.instructFor("Annoyed")).toBe("不耐煩、拖長音");
    expect(p.instructFor("neutral")).toBeNull();
    expect(p.instructFor(null)).toBeNull();
  });

  it("explicit_voice_and_empty_profile", () => {
    expect(VoiceProfile.parse("x", parseToml('voice = "miyoria-v2"') as JsonObject).voice).toBe(
      "miyoria-v2",
    );
    const empty = VoiceProfile.parse("x", null);
    expect(empty.voice).toBe("x");
    expect(empty.instruct.size).toBe(0);
  });

  it("config_defaults", () => {
    const c = VoiceConfigSchema.parse({});
    expect(c.consent).toBe("opt-out");
    expect(c.barge_in).toBe("selective");
    expect([c.end_silence_ms, c.max_utterance_ms, c.min_utterance_ms]).toEqual([600, 15_000, 300]);
    const d = VoiceConfigSchema.parse({ consent: "opt-in", barge_in: "ignore" });
    expect(d.consent).toBe("opt-in");
    expect(d.barge_in).toBe("ignore");
  });
});

// ------------------------------------------------------------------ hearing

describe("semaphore", () => {
  it("try_acquire_returns_null_when_all_permits_are_taken", () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire();
    expect(release).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
    release?.();
    const again = sem.tryAcquire();
    expect(again).not.toBeNull();
    again?.();
  });
});

describe("hearing", () => {
  function setup(transcribe: () => Promise<string>, slots = new Semaphore(1)) {
    const calls: { hints: AsrHint[]; count: number } = { hints: [], count: 0 };
    const speech = {
      transcribe: async (_audio: unknown, hint: AsrHint) => {
        calls.count++;
        calls.hints.push(hint);
        const text = await transcribe();
        return ["fake", { text, language: null, emotion: null, audio_events: [] }];
      },
    } as unknown as SpeechService;
    const hearing = new Hearing({
      speech,
      consent: new Consent("opt-out", new MemorySettingsStore()),
      asrSlots: slots,
      config: { to_traditional: true, hallucinations: ["thanks for watching"] },
      log: { debug: () => {}, warn: () => {} } as never,
    });
    return { hearing, calls };
  }
  const samples = new Int16Array(16_000);
  const signal = new AbortController().signal;

  it("busy_asr_drops_stream_speech", async () => {
    const slots = new Semaphore(1);
    const { hearing, calls } = setup(async () => "hello", slots);
    const held = slots.tryAcquire();
    expect(await hearing.transcribe(samples, signal)).toBeNull();
    expect(calls.count).toBe(0);
    held?.();
    expect(await hearing.transcribe(samples, signal)).toBe("hello");
    expect(slots.tryAcquire()).not.toBeNull(); // the permit was released
  });

  it("never_takes_a_slot_while_people_speaking_hold_them_all", async () => {
    const slots = new Semaphore(2);
    const { hearing, calls } = setup(async () => "hello", slots);
    const a = await slots.acquire();
    const b = await slots.acquire();
    expect(await hearing.transcribe(samples, signal)).toBeNull();
    expect(calls.count).toBe(0);
    a();
    expect(await hearing.transcribe(samples, signal)).toBe("hello");
    b();
  });

  it("transcript_is_cleaned", async () => {
    const a = setup(async () => "Thanks for watching");
    expect(await a.hearing.transcribe(samples, signal)).toBeNull();
    const b = setup(async () => "这个软件");
    expect(await b.hearing.transcribe(samples, signal)).toBe("這個軟體");
    expect(b.calls.hints[0]).toEqual({ language: null, prompt: null });
  });

  it("asr_failure_returns_null", async () => {
    const slots = new Semaphore(1);
    const { hearing } = setup(() => Promise.reject(new Error("asr down")), slots);
    expect(await hearing.transcribe(samples, signal)).toBeNull();
    expect(slots.tryAcquire()).not.toBeNull();
  });

  it("allowed_follows_consent", async () => {
    const { hearing } = setup(async () => "x");
    expect(await hearing.allowed(acc("1"))).toBe(true);
  });
});

describe("the TTS reference of a line", () => {
  const bank = (clips: string[]) =>
    VoiceProfile.parse("p", {
      design: {
        instruct: "ignored here",
        bank: {
          Japanese: Object.fromEntries(clips.map((c) => [c, "line"])),
          Chinese: { Neutral: "line" },
        },
      },
    });

  it("reads the clips her bank was designed with", () => {
    expect([...bank(["happy", "sad"]).clips].sort()).toEqual(["happy", "neutral", "sad"]);
    expect([...VoiceProfile.parse("p", null).clips]).toEqual([]);
  });

  it("the clip that matches, for a tag or an emotion's own name", () => {
    const p = bank(["happy", "angry"]);
    expect(p.referenceFor("happy")).toBe("happy");
    expect(p.referenceFor(" Happy ")).toBe("happy");
    expect(p.referenceFor("joy")).toBe("happy");
    expect(p.referenceFor("frustration")).toBe("angry");
  });

  it("the next clip that fits, when the bank has no such clip", () => {
    expect(bank(["embarrassed"]).referenceFor("surprised")).toBe("embarrassed");
    expect(bank(["surprised", "embarrassed"]).referenceFor("surprised")).toBe("surprised");
    expect(bank(["embarrassed"]).referenceFor("fear")).toBe("embarrassed");
  });

  it("past that it is the worker's: it falls back to neutral, then the plain reference", () => {
    expect(bank(["happy"]).referenceFor("angry")).toBe("angry");
    expect(bank(["happy"]).referenceFor("thinking")).toBe("thinking");
  });

  it("a profile that lists no bank, or a line with no tone, asks for nothing in particular", () => {
    const plain = VoiceProfile.parse("p", null);
    expect(plain.referenceFor("surprised")).toBe("surprised");
    expect(plain.referenceFor(null)).toBeNull();
    expect(plain.referenceFor("  ")).toBeNull();
  });

  it("every emotion of the table finds a clip in her real bank", () => {
    const p = VoiceProfile.parse("deepseek-chan", deepseekVoice());
    expect(p.clips.size).toBeGreaterThan(1);
    for (const name of EMOTION_NAMES) {
      const clip = p.referenceFor(EMOTION_OUTPUTS[name].tag) as string;
      expect(p.clips.has(clip), `${name} → ${clip}`).toBe(true);
    }
  });
});
