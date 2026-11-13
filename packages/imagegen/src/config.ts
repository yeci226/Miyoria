// `[modules.imagegen]` (docs/design/imagegen.md §4).

import { z } from "zod";

const LoraSchema = z.object({ name: z.string().min(1), strength: z.number().min(-10).max(10) });

const FilesSchema = z
  .object({
    diffusion_model: z.string().min(1),
    text_encoder: z.string().min(1),
    vae: z.string().min(1),
  })
  .partial();

const VariantOverrideSchema = z
  .object({
    files: FilesSchema,
    steps: z.number().int().min(1).max(200),
    cfg: z.number().min(0).max(30),
    sampler: z.string().min(1),
    scheduler: z.string().min(1),
    loras: z.array(LoraSchema).max(8),
  })
  .partial();

/** `[modules.imagegen.models.<id>]`: anything an adapter has by default. */
const ModelOverrideSchema = z
  .object({
    enabled: z.boolean().default(true),
    files: FilesSchema.default({}),
    default_variant: z.string().min(1).optional(),
    variants: z.record(z.string(), VariantOverrideSchema).default({}),
    width: z.number().int().min(64).max(8192).optional(),
    height: z.number().int().min(64).max(8192).optional(),
    default_negative: z.string().max(2000).optional(),
    prompt_prefix: z.string().max(500).optional(),
    /** MOSS-Image only: skip-layer guidance on the uncond pass (the template's SLG switch). */
    slg: z.boolean().optional(),
  })
  .strict();
export type ModelOverride = z.output<typeof ModelOverrideSchema>;

/** `HH:MM-HH:MM` in local time (it may wrap past midnight). */
const HOURS = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export const ImageGenConfigSchema = z
  .object({
    /** ComfyUI's address. Keep it on 127.0.0.1 or the LAN: ComfyUI has no login. */
    url: z.string().url().default("http://127.0.0.1:8188"),
    /** Extra headers on every request (a token for a reverse proxy in front of ComfyUI). */
    headers: z.record(z.string(), z.string()).default({}),
    /** Where pictures and job records go (relative to the config file's directory). */
    output_dir: z.string().min(1).default("data/images"),
    /** Workflow files (`<id>.json`, exported with "Export (API)"). */
    workflows_dir: z.string().min(1).default("data/imagegen/workflows"),
    /** Start pictures (image to image) may only be read from here. */
    input_dir: z.string().min(1).default("data/imagegen/input"),
    /** The model a request without `model` or `workflow` uses. */
    default_model: z.string().min(1).default("krea2"),
    models: z.record(z.string(), ModelOverrideSchema).default({}),
    /** Batch jobs only run inside these local hours (`null`: any time). */
    batch_hours: z.string().regex(HOURS).nullable().default(null),
    /** Hold every job while she sings or a song is being prepared on the GPU. */
    pause_while_singing: z.boolean().default(true),
    /** Ask ComfyUI to unload its models when a song starts being prepared or sung. */
    free_on_sing: z.boolean().default(true),
    /** Unload ComfyUI's models after this long with nothing to do (`0`: never). */
    free_after_idle_s: z.number().int().min(0).default(120),
    /** Longest one run may take before it is interrupted and failed. */
    timeout_s: z.number().int().min(10).default(600),
    /** Runs of a job when ComfyUI cannot be reached (a refused graph is not retried). */
    max_attempts: z.number().int().min(1).max(10).default(3),
    /** Most jobs waiting at once. */
    max_queued: z.number().int().min(1).max(100_000).default(2000),
    /** Jobs per purpose and local day (`{ gacha = 300 }`); a purpose not named has no limit. */
    daily_limits: z.record(z.string(), z.number().int().min(0)).default({}),
    /** Most pictures one job may make. */
    max_batch: z.number().int().min(1).max(64).default(8),
    /** Check that the model files are in ComfyUI before queueing a built-in model's job. */
    check_files: z.boolean().default(true),
    /** How often a running job's history is read. */
    poll_ms: z.number().int().min(100).default(1000),
    /** Finished job records older than this are deleted with their pictures (`0`: kept). */
    keep_days: z.number().int().min(0).default(0),
    /** Where "today" starts, for the daily limits and the batch hours. */
    utc_offset_minutes: z.number().int().min(-720).max(840).default(480),
  })
  .strict();
export type ImageGenConfig = z.output<typeof ImageGenConfigSchema>;

/** Minutes after local midnight of `HH:MM-HH:MM`'s two ends. */
export function parseHours(hours: string): { from: number; to: number } | null {
  const m = HOURS.exec(hours);
  if (!m) return null;
  return { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]) };
}

/** Whether local minute-of-day `at` is inside `range` (which may wrap past midnight). */
export function insideHours(range: { from: number; to: number }, at: number): boolean {
  if (range.from === range.to) return true;
  return range.from < range.to
    ? at >= range.from && at < range.to
    : at >= range.from || at < range.to;
}
