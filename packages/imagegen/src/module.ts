import {
  defineManifest,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import {
  ImageGenKey,
  parseSongCue,
  parseSongPrepare,
  SONG_PREPARE_TOPIC,
  SONG_TOPIC,
} from "@miyoria/types";
import { ComfyClient } from "./comfy.js";
import { ImageGenConfigSchema } from "./config.js";
import { ImageGenService } from "./service.js";

/**
 * Module `imagegen` (docs/design/imagegen.md): pictures made on a ComfyUI server. Provides
 * `ImageGen` (`ImageGenKey`) for the other parts of her; it has no commands and nothing a member
 * can call. Off unless `[modules.imagegen] enabled = true`. Listens to the `sing` module's cues
 * so the GPU goes to her songs first.
 */
export class ImageGenModule implements Module {
  static readonly ID = "imagegen";
  readonly manifest = defineManifest(ImageGenModule.ID, "Image generation", {
    description: "Pictures made on a ComfyUI server: Krea 2, MOSS-Image, Anima and workflow files",
    optional: ["sing"],
    configSchema: ImageGenConfigSchema,
  });
  readonly #baseDir: string;
  #service: ImageGenService | null = null;

  constructor(options: { baseDir?: string } = {}) {
    this.#baseDir = options.baseDir ?? process.cwd();
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ImageGenConfigSchema);
    const client = new ComfyClient({ url: config.url, headers: config.headers });
    const service = new ImageGenService({
      config,
      baseDir: this.#baseDir,
      client,
      clock: ctx.clock,
      log: ctx.log,
      publish: (event) => ctx.publish(event),
    });
    await service.load();
    this.#service = service;
    ctx.provide(ImageGenKey, service);

    const songs = ctx.subscribe([SONG_TOPIC, SONG_PREPARE_TOPIC]);
    ctx.spawn("songs", async () => {
      for await (const env of songs) {
        if (env.event.type !== "custom") continue;
        const { topic, payload } = env.event.data;
        if (topic === SONG_TOPIC) {
          const cue = parseSongCue(payload);
          if (cue) service.onSongCue(cue);
        } else if (topic === SONG_PREPARE_TOPIC) {
          const prepare = parseSongPrepare(payload);
          if (prepare) service.onSongPrepare(prepare);
        }
      }
    });
    ctx.spawn("jobs", (signal) => service.run(signal));
    ctx.log.info(
      { url: config.url, models: service.models().map((m) => m.id) },
      "image generation ready",
    );
  }

  async health(): Promise<Health> {
    const service = this.#service;
    if (service === null) return HEALTHY;
    const status = await service.status();
    if (!status.reachable)
      return { status: "degraded", reason: `ComfyUI is not answering at ${service.config.url}` };
    return HEALTHY;
  }

  async stop(): Promise<void> {
    this.#service = null;
  }
}
