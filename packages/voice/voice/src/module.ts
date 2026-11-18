// Module `voice`: listening and speaking in voice channels.

import { CommandMount } from "@miyoria/commands";
import { actuatorsFor } from "@miyoria/gate/actions";
import { contextSession, LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  sleep,
} from "@miyoria/runtime/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import {
  type EventPayload,
  Events,
  type JsonObject,
  type ProfileId,
  SpeechPauseKey,
  VoiceFloorKey,
  VoiceSinkKey,
  VoiceTurnsKey,
  WorldStateKey,
} from "@miyoria/types";
import {
  type EndpointsOption,
  type SpeechService,
  SpeechServiceKey,
} from "../../speech/src/index.js";
import { voiceCapabilities } from "./actions.js";
import { BargeIn } from "./barge.js";
import { ClipRecorder } from "./clips.js";
import { registerCommands, unregisterCommands } from "./commands.js";
import { fillerLines, type VoiceConfig, VoiceConfigSchema, VoiceProfile } from "./config.js";
import { Consent } from "./consent.js";
import { E2eLatency, e2eJson } from "./e2e.js";
import { SelfEchoGuard } from "./echo.js";
import { Filler, FillerBank } from "./filler.js";
import { Hearing, StreamHearingKey } from "./hearing.js";
import { type VoiceLink, VoiceLinkKey } from "./link/link.js";
import { VoiceLinkModule } from "./link/module.js";
import { Listener } from "./listen.js";
import { LinePrefetch } from "./prefetch.js";
import { sileroVad } from "./silero.js";
import { Speaker } from "./sink.js";
import { SpeechTranslator } from "./translate.js";
import { HttpTurnJudge, TurnGate } from "./turn.js";
import { Semaphore } from "./util.js";
import { registerVadEngine } from "./vad.js";

/** Tries at synthesizing the filler sounds (TTS may come up after Core), a minute apart. */
const FILLER_ATTEMPTS = 30;
const FILLER_RETRY_MS = 60_000;

/**
 * Module `voice`: listens in voice channels (VAD → ASR → `voice.utterance`) and speaks
 * (`VoiceSink` → TTS → playback), with consent, barge-in and the `join` / `leave` /
 * `/voice join | leave | consent | golive ...` commands.
 *
 * Requires `voice.link` (`VoiceLinkKey`) and `speech` (`SpeechServiceKey`); uses the
 * `SettingsStore` for consent flags, the `CommandRegistry` for commands and the LLM router for
 * `tts_translate` when available. Registers the capabilities `voice.join`, `voice.leave`,
 * `stream.start` and `stream.stop` in the actuator registry; the commands go through it too.
 */
export class VoiceModule implements Module {
  static readonly ID = "voice";
  readonly manifest = defineManifest(VoiceModule.ID, "Voice", {
    icon: "mic",
    category: "platform",
    description: "Listens and speaks in voice channels",
    requires: [VoiceLinkModule.ID, "speech"],
    optional: ["commands", "llm"],
    configSchema: VoiceConfigSchema,
  });
  readonly #profileId: ProfileId;
  readonly #voice: JsonObject | null;
  readonly #names: readonly string[];
  readonly #endpoints: EndpointsOption | null;
  #barge: BargeIn | null = null;
  #fillerTimer: Filler | null = null;
  #e2e: E2eLatency | null = null;
  #link: VoiceLink | null = null;
  #commands: CommandMount | null = null;
  #capabilities: (() => void)[] = [];

  /**
   * `voice` is the profile's `voice.toml` (`Profile.voice`); `names`: what people call her
   * (`Profile.names()`), so her name in a transcript stops her when somebody talks over her.
   * `endpoints`: Core's endpoint registry, where Smart Turn (`turn`) and Silero (`vad`) run.
   */
  constructor(
    profileId: ProfileId,
    voice: JsonObject | null,
    names: readonly string[] = [],
    options: { endpoints?: EndpointsOption } = {},
  ) {
    this.#profileId = profileId;
    this.#voice = voice;
    this.#names = names;
    this.#endpoints = options.endpoints ?? null;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(VoiceConfigSchema);
    const profile = VoiceProfile.parse(this.#profileId, this.#voice);
    const link = ctx.services.require(VoiceLinkKey);
    const speech = ctx.services.require(SpeechServiceKey);
    const endpoints = this.#endpoints?.(ctx.services) ?? null;
    const store = ctx.services.get(SettingsStoreKey) ?? null;
    if (store === null) {
      ctx.log.warn("no settings store: voice consent choices are kept in memory only");
    }
    const consent = new Consent(config.consent, store, ctx.clock);
    let speaker: Speaker | null = null;
    if (config.vad_engine === "silero") registerVadEngine("silero", sileroVad);
    const smartTurn = config.turn_engine === "smart-turn";
    const gate = smartTurn ? new TurnGate(() => ctx.clock.now()) : null;
    const barge = new BargeIn(
      config.barge_in,
      config.barge_in_ms,
      config.barge_in_fade_ms,
      {
        duckMs: config.barge_in_duck_ms,
        duckGain: config.barge_in_duck_gain,
        focusStopMs: config.barge_in_focus_stop_ms,
        // The utterance of somebody who just stopped talking arrives after the end silence.
        settleMs: Math.max(config.end_silence_ms, smartTurn ? config.turn_max_silence_ms : 0) + 500,
        publish: (record) => {
          ctx.publish(
            Events.VoiceBargeIn,
            {
              context: { ...record.context },
              turn: record.turn,
              account: record.account === null ? null : { ...record.account },
              action: record.action,
              reason: record.reason,
            },
            { turn: record.turn },
          );
          // The rest of her lines are dropped: do not synthesize them for nothing.
          if (record.action === "stop" && record.context.scope !== null) {
            speaker?.cancelPrefetch(record.context.scope);
          }
        },
      },
      () => ctx.clock.now(),
    );
    this.#barge = barge;
    const echo = new SelfEchoGuard({
      now: () => ctx.clock.now(),
      tailMs: config.self_echo_tail_ms,
    });
    const prefetch =
      config.tts_prefetch > 0
        ? new LinePrefetch({
            limit: config.tts_prefetch,
            ttlMs: config.tts_prefetch_ttl_ms,
            signal: ctx.signal,
          })
        : null;

    const e2e = new E2eLatency({
      now: () => ctx.clock.now(),
      emit: (record) => {
        ctx.log.info(
          {
            turn: record.turn,
            complete: record.complete,
            reason: record.reason,
            total_ms: record.total_ms,
            ...record.segments,
            // The agent's parts, so one log line reads the whole timeline.
            ...(record.parts
              ? {
                  wait: record.parts.prepare.wait,
                  decide: record.parts.prepare.decide,
                  context: record.parts.prepare.context,
                  prompt: record.parts.prepare.prompt,
                  first_token: record.parts.llm_first.first_token,
                  held: record.parts.llm_first.held,
                  speculative: record.speculative === true,
                }
              : {}),
            ...(record.filler_ms === undefined ? {} : { filler_ms: record.filler_ms }),
          },
          "voice e2e latency",
        );
        const payload = { stage: "e2e", ...e2eJson(record) };
        ctx.publish(Events.VoiceLatency, payload as EventPayload<typeof Events.VoiceLatency>, {
          turn: record.turn,
        });
      },
    });
    this.#e2e = e2e;

    if (!speech.hasTts()) ctx.log.warn("no TTS provider configured: she cannot speak");
    let translator: SpeechTranslator | null = null;
    if (config.tts_translate !== null) {
      const router = ctx.services.get(LlmRouterKey);
      if (router) {
        translator = new SpeechTranslator(
          router,
          config.tts_translate_purpose,
          config.tts_translate,
          ctx.log,
        );
      } else {
        ctx.log.warn("tts_translate is set but there is no LLM router: she speaks untranslated");
      }
    }
    speaker = new Speaker({
      ctx,
      link,
      speech,
      profile,
      config,
      barge,
      translator,
      session: (context) => contextSession(this.#profileId, context),
      echo,
      prefetch,
      e2e,
      gate,
    });
    ctx.provide(VoiceSinkKey, speaker);

    let listener: Listener | null = null;
    const filler = this.#filler(
      ctx,
      config,
      profile,
      speech,
      speaker,
      barge,
      translator,
      () => listener,
    );
    this.#fillerTimer = filler;
    ctx.provide(VoiceTurnsKey, {
      mark: (turn, focus, mark, at) => e2e.mark(turn, focus, mark, at),
      expect: (context, turn, startedAt) => filler?.expect(context, turn, startedAt),
      settle: (turn) => filler?.settle(turn),
    });

    if (speech.hasAsr()) {
      const asrSlots = new Semaphore(Math.max(1, config.asr_concurrency));
      ctx.provide(StreamHearingKey, new Hearing({ speech, consent, asrSlots, config }));
      listener = new Listener({
        ctx,
        link,
        speech,
        consent,
        config,
        barge,
        asrSlots,
        echo,
        names: [...config.names, ...this.#names],
        e2e,
        turn: smartTurn
          ? new HttpTurnJudge({
              endpoints,
              timeoutMs: config.turn_timeout_ms,
              now: () => ctx.clock.now(),
              warn: (message) => ctx.log.warn(message),
            })
          : null,
        gate,
        clips:
          config.clip_dir === null
            ? null
            : new ClipRecorder(config.clip_dir, (message) => ctx.log.warn(message)),
        endpoints,
      });
      const audio = link.subscribeAudio(ctx.signal);
      const running = listener;
      ctx.spawn("listen", (signal) => running.run(audio, signal));
    } else {
      ctx.log.warn("no ASR provider configured: she cannot listen");
    }

    this.#link = link;
    const actuators = actuatorsFor(ctx);
    this.#capabilities = voiceCapabilities(
      link,
      () => ({ source: config.golive_source, listen: config.golive_listen }),
      () => ctx.services.get(WorldStateKey),
      () => ctx.services.get(VoiceFloorKey),
    ).map((c) => actuators.register(c));
    const commands = new CommandMount(
      "voice",
      (registry) => registerCommands(registry, link, consent, config.golive_source, actuators),
      unregisterCommands,
    );
    this.#commands = commands;
    commands.attach(ctx);
    ctx.log.info(
      {
        voice: profile.voice,
        consent: config.consent,
        speaks: translator?.language ?? null,
        turn: config.turn_engine,
        vad: config.vad_engine,
      },
      "voice module running",
    );
  }

  /**
   * The filler (filler.ts): its sounds are read from the cache, the missing ones synthesized in the
   * background once TTS answers. `null` when off, without TTS, or with no lines for the language.
   */
  #filler(
    ctx: ModuleContext,
    config: VoiceConfig,
    profile: VoiceProfile,
    speech: SpeechService,
    speaker: Speaker,
    barge: BargeIn,
    translator: SpeechTranslator | null,
    listener: () => Listener | null,
  ): Filler | null {
    const language = translator?.language ?? config.tts_language;
    const lines = config.filler ? fillerLines(config, language) : [];
    if (lines.length === 0 || !speech.hasTts()) return null;
    const bank = new FillerBank({
      dir: config.filler_dir,
      voice: profile.voice,
      language,
      lines,
      maxMs: config.filler_max_ms,
      synthesize: async (text, signal) => {
        const request = {
          text,
          language,
          emotion: null,
          instruct: null,
          voice: profile.voice,
          priority: "ahead" as const,
        };
        const [, stream] = await speech.synthesize(request, signal);
        const parts: Int16Array[] = [];
        let sampleRate = 0;
        for await (const chunk of stream) {
          if (chunk.samples.length === 0) continue;
          sampleRate = chunk.sampleRate;
          parts.push(chunk.samples);
        }
        const samples = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
          samples.set(p, at);
          at += p.length;
        }
        return { sampleRate, samples };
      },
      warn: (message) => ctx.log.debug(message),
    });
    // Read or made when she is first expected to answer in voice: no GPU work for a Core that
    // never joins a channel, and that first turn is the only one without a filler.
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      ctx.spawn("filler", async (signal) => {
        for (let attempt = 0; attempt < FILLER_ATTEMPTS && !signal.aborted; attempt++) {
          // The GPU is lent to a song: TTS has no model now.
          if (ctx.services.get(SpeechPauseKey)?.paused() == null) {
            const missing = await bank.load(signal);
            if (missing === 0) {
              ctx.log.info({ fillers: bank.clips().map((c) => c.text) }, "filler sounds ready");
              return;
            }
          }
          await sleep(FILLER_RETRY_MS, signal).catch(() => undefined);
        }
        if (!signal.aborted) ctx.log.warn("filler sounds could not all be synthesized");
      });
    };
    return new Filler({
      load,
      now: () => ctx.clock.now(),
      afterMs: config.filler_after_ms,
      clips: () => bank.clips(),
      quiet: (guild, since) => speaker.quiet(guild, since),
      talking: (guild) => listener()?.talking(guild) ?? false,
      stopped: (guild, turn) => barge.isStopped(guild, turn),
      play: (context, turn, clip) => speaker.playFiller(context, turn, clip),
      random: Math.random,
      skipped: (turn, reason) => ctx.log.debug({ turn, reason }, "no filler"),
    });
  }

  async stop(): Promise<void> {
    this.#fillerTimer?.close();
    this.#fillerTimer = null;
    this.#barge?.close();
    this.#barge = null;
    this.#e2e?.clear();
    this.#e2e = null;
    this.#commands?.detach();
    this.#commands = null;
    for (const unregister of this.#capabilities) unregister();
    this.#capabilities = [];
  }

  async health(): Promise<Health> {
    const link = this.#link;
    if (link && !link.isConnected()) {
      return { status: "degraded", reason: "voice node not connected" };
    }
    return HEALTHY;
  }
}
