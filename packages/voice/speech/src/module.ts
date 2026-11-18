// The `speech` module: builds providers from config and provides `SpeechService`.

import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import type { JsonValue } from "@miyoria/types";
import { z } from "zod";
import { HttpWorkerAsrFactory, OpenAiAsrFactory } from "./asr.js";
import type { EndpointsOption } from "./endpoints.js";
import {
  GptSovitsFactory,
  HttpWorkerTtsFactory,
  OpenAiTtsFactory,
  VllmOmniTtsFactory,
} from "./tts.js";
import {
  type AsrFactory,
  type AsrProvider,
  NO_ENV,
  type ProviderConfig,
  type ProviderEnv,
  SpeechError,
  SpeechService,
  SpeechServiceKey,
  type TtsFactory,
  type TtsProvider,
} from "./types.js";

/** `[speech.asr.<name>]` / `[speech.tts.<name>]`: `kind` plus every other key as `settings`. */
export const ProviderConfigSchema = z.looseObject({ kind: z.string() }).transform(
  ({ kind, ...settings }): ProviderConfig => ({
    kind,
    settings: settings as Record<string, JsonValue>,
  }),
);

/**
 * Top-level `[speech]` config section (not under `[modules.*]`; the app passes it in, like
 * `[llm]`).
 *
 * ```toml
 * [speech.asr.local]
 * kind = "http-worker"
 * url = "http://127.0.0.1:8101"   # a static entry of the endpoint registry; left out: any `asr`
 *
 * [speech.asr.groq]
 * kind = "openai"
 * base_url = "https://api.groq.com/openai/v1"
 * api_key = "${GROQ_API_KEY}"
 * model = "whisper-large-v3-turbo"
 *
 * [speech.tts.qwen]
 * kind = "http-worker"
 * url = "http://127.0.0.1:8102"
 * voice = "deepseek-chan"
 *
 * [speech]
 * asr_chain = ["local", "groq"]   # default: all configured, in name order
 * tts_chain = ["qwen"]
 * ```
 */
export const SpeechConfigSchema = z.object({
  asr: z.record(z.string(), ProviderConfigSchema).default({}),
  tts: z.record(z.string(), ProviderConfigSchema).default({}),
  /** Provider names in fallback order; `null` = every configured provider. */
  asr_chain: z.array(z.string()).nullable().default(null),
  tts_chain: z.array(z.string()).nullable().default(null),
});
export type SpeechConfig = z.output<typeof SpeechConfigSchema>;

/** All built-in ASR factories: `http-worker`, `openai`. */
export function defaultAsrFactories(): AsrFactory[] {
  return [new HttpWorkerAsrFactory(), new OpenAiAsrFactory()];
}

/** All built-in TTS factories: `http-worker`, `openai`, `vllm-omni`, `gpt-sovits`. */
export function defaultTtsFactories(): TtsFactory[] {
  return [
    new HttpWorkerTtsFactory(),
    new OpenAiTtsFactory(),
    new VllmOmniTtsFactory(),
    new GptSovitsFactory(),
  ];
}

/** Entries ordered by key (ascending by code unit). */
function byName<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Builds all providers of one family (so config errors surface even for providers outside the
 * chain), then picks the chain order.
 */
function buildChain<P>(
  family: string,
  configs: Record<string, ProviderConfig>,
  chain: readonly string[] | null,
  build: (name: string, config: ProviderConfig) => P,
): P[] {
  const built = new Map<string, P>();
  for (const [name, cfg] of byName(configs)) {
    try {
      built.set(name, build(name, cfg));
    } catch (error) {
      throw new SpeechError(`speech.${family}.${name}: ${errorMessage(error)}`, { cause: error });
    }
  }
  if (chain === null) return [...built.values()];
  return chain.map((n) => {
    const p = built.get(n);
    if (p === undefined) {
      throw new SpeechError(`speech.${family}_chain: unknown provider \`${n}\``);
    }
    return p;
  });
}

export interface SpeechModuleOptions {
  /** Core's endpoint registry, where the `http-worker` providers' workers are. */
  endpoints?: EndpointsOption;
}

/**
 * Module `speech`: provides `SpeechService` (`SpeechServiceKey`). The `http-worker` providers find
 * their worker in Core's endpoint registry (`endpoints`) at each call.
 */
export class SpeechModule implements Module {
  static readonly ID = "speech";
  readonly manifest = defineManifest(SpeechModule.ID, "Speech", {
    icon: "audio-lines",
    category: "platform",
    description: "ASR / TTS providers with fallback chains",
  });
  readonly #config: SpeechConfig;
  readonly #asrFactories: readonly AsrFactory[];
  readonly #ttsFactories: readonly TtsFactory[];
  readonly #endpoints: EndpointsOption | null;

  constructor(
    config: SpeechConfig,
    asrFactories: readonly AsrFactory[],
    ttsFactories: readonly TtsFactory[],
    options: SpeechModuleOptions = {},
  ) {
    this.#config = config;
    this.#asrFactories = asrFactories;
    this.#ttsFactories = ttsFactories;
    this.#endpoints = options.endpoints ?? null;
  }

  /** Registers every built-in provider kind. */
  static withDefaultFactories(
    config: SpeechConfig,
    options: SpeechModuleOptions = {},
  ): SpeechModule {
    return new SpeechModule(config, defaultAsrFactories(), defaultTtsFactories(), options);
  }

  /** Builds every configured provider and assembles the chains. */
  buildService(env: ProviderEnv = NO_ENV): SpeechService {
    const asr = buildChain<AsrProvider>(
      "asr",
      this.#config.asr,
      this.#config.asr_chain,
      (name, cfg) => {
        const f = this.#asrFactories.find((f) => f.kinds.includes(cfg.kind));
        if (!f) throw new SpeechError(`unknown ASR kind \`${cfg.kind}\``);
        return f.build(name, cfg, env);
      },
    );
    const tts = buildChain<TtsProvider>(
      "tts",
      this.#config.tts,
      this.#config.tts_chain,
      (name, cfg) => {
        const f = this.#ttsFactories.find((f) => f.kinds.includes(cfg.kind));
        if (!f) throw new SpeechError(`unknown TTS kind \`${cfg.kind}\``);
        return f.build(name, cfg, env);
      },
    );
    return new SpeechService(asr, tts);
  }

  async start(ctx: ModuleContext): Promise<void> {
    const service = this.buildService({ endpoints: this.#endpoints?.(ctx.services) ?? null });
    ctx.log.info({ asr: service.hasAsr(), tts: service.hasTts() }, "speech ready");
    ctx.provide(SpeechServiceKey, service);
  }
}
