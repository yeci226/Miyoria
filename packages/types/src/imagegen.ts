// Image generation (`packages/imagegen`, docs/design/imagegen.md): other parts of her ask for
// pictures through `ImageGen` (`ImageGenKey`); the module runs them on a ComfyUI server, one job
// at a time, and keeps every job and its pictures on disk. Nothing here is user-facing: there are
// no commands, and a picture is only a file until whoever asked for it decides what it is for.
//
// A job either names a built-in model (`model`: `krea2`, `moss_image`, `anima`), whose graph the
// module builds, or a workflow file exported from ComfyUI (`workflow`), whose declared parameters
// it fills in. Jobs and their pictures are written with a sidecar that records everything needed
// to make the same picture again (graph, seed, model files).

import type { JsonValue } from "./json.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** Topic of `ImageJobEvent` custom events: one per state change of a job. */
export const IMAGEGEN_TOPIC = "imagegen.job";

export type ImageJobState = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * `interactive` jobs run before every `batch` job and are not held back by the batch window;
 * both wait while she sings (when the module is set to).
 */
export type ImageJobPriority = "interactive" | "batch";

/** A LoRA applied to the diffusion model (`LoraLoaderModelOnly`), file name as ComfyUI lists it. */
export interface ImageLora {
  name: string;
  strength: number;
}

/**
 * What a job asks for. In-process callers pass `ImageRequestInput`; the module fills in the
 * model's defaults and stores this resolved form, so a job says exactly what it ran with.
 */
export interface ImageRequest {
  /** A built-in model adapter (`krea2`, `moss_image`, `anima`); `null` with `workflow`. */
  model: string | null;
  /** The model's variant (`turbo` / `raw`, `sft` / `base`, `base` / `turbo`); `null`: its default. */
  variant: string | null;
  /** A workflow file's id (`<workflows_dir>/<id>.json`); `null` with `model`. */
  workflow: string | null;
  prompt: string;
  /** Ignored by models that use no negative prompt (Krea 2). */
  negative: string | null;
  width: number | null;
  height: number | null;
  /** `null`: a random one, chosen when the job is submitted and stored with it. */
  seed: number | null;
  steps: number | null;
  cfg: number | null;
  sampler: string | null;
  scheduler: string | null;
  /** Pictures per run (the latent batch size). */
  batch: number;
  loras: ImageLora[];
  /** A picture to start from (image to image): a file path under the module's input dir, or a
   * name ComfyUI already has in its `input` folder. */
  init_image: string | null;
  /** How much of `init_image` is redrawn (0..1); `null` with no `init_image`. */
  denoise: number | null;
  /** Extra workflow parameters by name (a workflow file declares them). */
  params: Record<string, JsonValue>;
}

/** `ImageRequest` with every field but `prompt` optional, for callers. */
export type ImageRequestInput = Partial<Omit<ImageRequest, "prompt">> & { prompt: string };

export interface ImageSubmitOptions {
  /** What the picture is for (`gacha`, `fortune`, ...): the daily limits and the files go by it. */
  purpose: string;
  priority?: ImageJobPriority;
  /** The same key again answers the same job instead of making a second one. */
  key?: string | null;
  /** Free text kept with the job (who or what asked), for the log and the files. */
  note?: string | null;
}

/** One picture a job made. */
export interface ImageOutput {
  /** Absolute path of the PNG on this machine. */
  path: string;
  /** Path relative to the module's output dir (stable across moves of the dir). */
  file: string;
  /** Its index in the job's batch. */
  index: number;
  bytes: number;
}

export interface ImageJob {
  id: string;
  key: string | null;
  purpose: string;
  priority: ImageJobPriority;
  note: string | null;
  state: ImageJobState;
  request: ImageRequest;
  /** ComfyUI's id of the run; `null` until it was queued there. */
  prompt_id: string | null;
  /** 0..1, from ComfyUI's sampler steps. */
  progress: number;
  /** The node ComfyUI is running now (its id), while running. */
  node: string | null;
  attempts: number;
  error: string | null;
  outputs: ImageOutput[];
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

/** Payload of `IMAGEGEN_TOPIC`. */
export interface ImageJobEvent {
  id: string;
  purpose: string;
  state: ImageJobState;
  progress: number;
  error: string | null;
  outputs: string[];
}

export interface ImageJobFilter {
  states?: readonly ImageJobState[];
  purpose?: string;
  limit?: number;
}

/** A built-in model adapter as the service describes it. */
export interface ImageModelInfo {
  id: string;
  label: string;
  variants: string[];
  default_variant: string;
  /** The model files this adapter loads, by ComfyUI folder (`diffusion_models`, ...). */
  files: Record<string, string>;
  uses_negative: boolean;
  /** How prompts for this model are best written. */
  prompt_hint: string;
  license: string;
}

/** A workflow file as the service describes it. */
export interface ImageWorkflowInfo {
  id: string;
  description: string;
  params: string[];
}

export interface ImageGenStatus {
  reachable: boolean;
  /** ComfyUI's version when it answered. */
  version: string | null;
  devices: { name: string; vram_total_mb: number; vram_free_mb: number }[];
  queued: number;
  running: string | null;
  /** Why queued jobs are not running now (`singing`, `outside_batch_hours`, `unreachable`), or `null`. */
  held: string | null;
}

/** The image generation service (`ImageGenKey`), provided by the `imagegen` module. */
export interface ImageGen {
  /** Queues a job (`ImageGenError` on a bad request, an unknown model or a daily limit). */
  submit(request: ImageRequestInput, options: ImageSubmitOptions): Promise<ImageJob>;
  get(id: string): Promise<ImageJob | null>;
  /** Newest first. */
  list(filter?: ImageJobFilter): Promise<ImageJob[]>;
  /** Resolves when the job is done, failed or cancelled. */
  wait(id: string, signal?: AbortSignal): Promise<ImageJob>;
  /** Cancels a queued or running job; `null` when there is no such job. */
  cancel(id: string): Promise<ImageJob | null>;
  models(): ImageModelInfo[];
  workflows(): Promise<ImageWorkflowInfo[]>;
  status(): Promise<ImageGenStatus>;
  /** Asks ComfyUI to unload its models and free VRAM now (it is idle otherwise anyway). */
  free(): Promise<void>;
}

export const ImageGenKey = serviceKey<ImageGen>("imagegen");
