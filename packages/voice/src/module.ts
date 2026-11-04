// Module `voice`: listening and speaking in voice channels.

import { actuatorsFor } from "@miyoria/actions";
import { CommandMount } from "@miyoria/commands";
import {
  defineManifest,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import { SpeechServiceKey } from "@miyoria/speech";
import { SettingsStoreKey } from "@miyoria/store";
import {
  type JsonObject,
  type ProfileId,
  VoiceFloorKey,
  VoiceSinkKey,
  WorldStateKey,
} from "@miyoria/types";
import { voiceCapabilities } from "./actions.js";
import { BargeIn } from "./barge.js";
import { registerCommands, unregisterCommands } from "./commands.js";
import { VoiceConfigSchema, VoiceProfile } from "./config.js";
import { Consent } from "./consent.js";
import { Hearing, StreamHearingKey } from "./hearing.js";
import { type VoiceLink, VoiceLinkKey } from "./link/link.js";
import { VoiceLinkModule } from "./link/module.js";
import { Listener } from "./listen.js";
import { Speaker } from "./sink.js";
import { SpeechTranslator } from "./translate.js";
import { Semaphore } from "./util.js";

/**
 * Module `voice`: listens in voice channels (VAD → ASR → `voice_utterance`) and speaks
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
    description: "Listens and speaks in voice channels",
    requires: [VoiceLinkModule.ID, "speech"],
    optional: ["commands", "llm"],
    configSchema: VoiceConfigSchema,
  });
  readonly #profileId: ProfileId;
  readonly #voice: JsonObject | null;
  #link: VoiceLink | null = null;
  #commands: CommandMount | null = null;
  #capabilities: (() => void)[] = [];

  /** `voice` is the profile's `voice.toml` (`Profile.voice`). */
  constructor(profileId: ProfileId, voice: JsonObject | null) {
    this.#profileId = profileId;
    this.#voice = voice;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(VoiceConfigSchema);
    const profile = VoiceProfile.parse(this.#profileId, this.#voice);
    const link = ctx.services.require(VoiceLinkKey);
    const speech = ctx.services.require(SpeechServiceKey);
    const store = ctx.services.get(SettingsStoreKey) ?? null;
    if (store === null) {
      ctx.log.warn("no settings store: voice consent choices are kept in memory only");
    }
    const consent = new Consent(config.consent, store, ctx.clock);
    const barge = new BargeIn(config.barge_in, config.barge_in_ms, config.barge_in_fade_ms);

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
    ctx.provide(
      VoiceSinkKey,
      new Speaker({ ctx, link, speech, profile, config, barge, translator }),
    );

    if (speech.hasAsr()) {
      const asrSlots = new Semaphore(Math.max(1, config.asr_concurrency));
      ctx.provide(StreamHearingKey, new Hearing({ speech, consent, asrSlots, config }));
      const listener = new Listener({
        ctx,
        link,
        speech,
        consent,
        config,
        barge,
        asrSlots,
      });
      const audio = link.subscribeAudio(ctx.signal);
      ctx.spawn("listen", (signal) => listener.run(audio, signal));
    } else {
      ctx.log.warn("no ASR provider configured: she cannot listen");
    }

    this.#link = link;
    const actuators = actuatorsFor(ctx);
    this.#capabilities = voiceCapabilities(
      link,
      () => config.golive_source,
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
      { voice: profile.voice, consent: config.consent, speaks: translator?.language ?? null },
      "voice module running",
    );
  }

  async stop(): Promise<void> {
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
