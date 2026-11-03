import { resolve } from "node:path";
import { actuatorsFor } from "@miyoria/actions";
import { CommandMount } from "@miyoria/commands";
import {
  defineManifest,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import {
  type PromptContributors,
  PromptContributorsKey,
  SpeechPauseKey,
  serviceKey,
  VoiceFloorKey,
} from "@miyoria/types";
import { singCapabilities } from "./actions.js";
import { HttpSingWorker, type SingWorker } from "./client.js";
import { registerCommands } from "./commands.js";
import { SingConfigSchema } from "./config.js";
import { PROMPT_KEY, SingPrompt } from "./prompt.js";
import { Singer } from "./singer.js";

/** The singing flow (set list, requests, playback), for the Admin API and tests. */
export const SingerKey = serviceKey<Singer>("Singer");

interface Running {
  singer: Singer;
  worker: SingWorker;
  commands: CommandMount;
  prompts: PromptContributors | null;
  capabilities: (() => void)[];
}

/**
 * Module `sing`: song requests sung in her voice. The song worker (`workers/sing`, default
 * `http://127.0.0.1:8005`) prepares covers; this module keeps the set list, offers ready songs
 * to her mind, plays them through the voice node (`VoicePlayerKey`) with lyrics cues and the
 * vocal stem as the lip-sync track, and holds the voice channel while a song plays
 * (`VoiceFloorKey`).
 *
 * Registers `sing.request` / `sing.play` / `sing.stop` (tools `sing_request` / `sing_start` /
 * `sing_stop`), `/queue song ...` and the prompt section `sing`; sings `[modules.queue]` items
 * of kind `song` when they are called. Services used (all optional): `VoicePlayer` (to sing),
 * `Mind`, `RequestQueue`, `CommandRegistry`, `PromptContributors`, `ActuatorRegistry`,
 * `SettingsStore` (the set list survives a restart, key `_global` / `sing:setlist`).
 */
export class SingModule implements Module {
  static readonly ID = "sing";
  readonly manifest = defineManifest(SingModule.ID, "Singing", {
    description: "Song requests: AI covers in her voice, sung in voice with lyrics",
    optional: ["voice.link", "mind", "queue", "commands", "actions", "agent"],
    configSchema: SingConfigSchema,
  });
  readonly #worker: ((url: string, timeoutMs: number) => SingWorker) | null;
  readonly #baseDir: string;
  #running: Running | null = null;

  /**
   * `worker`: replaces the HTTP client (tests). `baseDir`: what a relative `video_dir` is
   * relative to (the directory of `miyoria.toml`; default the working directory).
   */
  constructor(
    worker: ((url: string, timeoutMs: number) => SingWorker) | null = null,
    options: { baseDir?: string } = {},
  ) {
    this.#worker = worker;
    this.#baseDir = options.baseDir ?? process.cwd();
  }

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(SingConfigSchema);
    const timeoutMs = cfg.timeout_secs * 1000;
    const worker = this.#worker?.(cfg.url, timeoutMs) ?? new HttpSingWorker(cfg.url, timeoutMs);
    const videoDir = cfg.video ? resolve(this.#baseDir, cfg.video_dir) : null;
    const singer = new Singer(cfg, ctx, worker, videoDir);
    const actuators = actuatorsFor(ctx);
    const capabilities = singCapabilities(singer, cfg.permissions).map((c) =>
      actuators.register(c),
    );

    let paths: string[] = [];
    const commands = new CommandMount(
      "sing",
      (registry) => {
        paths = registerCommands(registry, cfg.permissions, actuators, singer);
      },
      (registry) => {
        for (const path of paths) registry.unregister(path);
      },
    );
    commands.attach(ctx);
    const prompts = ctx.services.get(PromptContributorsKey) ?? null;
    prompts?.register(new SingPrompt(singer));
    ctx.provide(SingerKey, singer);
    ctx.provide(VoiceFloorKey, singer);
    ctx.provide(SpeechPauseKey, singer);

    const events = ctx.subscribe([
      "voice.joined",
      "voice.left",
      "voice.playback",
      "agent.turn.completed",
      "action.completed",
      "queue.item_activated",
    ]);
    ctx.spawn("events", async () => {
      for await (const env of events) singer.onEvent(env.event);
    });
    await singer.restore();
    ctx.spawn("worker", (signal) => singer.run(signal));
    this.#running = { singer, worker, commands, prompts, capabilities };
  }

  async health(): Promise<Health> {
    const running = this.#running;
    if (!running) return HEALTHY;
    const why = await running.worker.health(AbortSignal.timeout(3000));
    return why === null ? HEALTHY : { status: "degraded", reason: why };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    await running.singer.save();
    running.singer.close();
    running.commands.detach();
    running.prompts?.unregister(PROMPT_KEY);
    for (const unregister of running.capabilities) unregister();
  }
}
