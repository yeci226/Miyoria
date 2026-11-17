// The built-in model adapters: Krea 2, MOSS-Image and Anima. Each knows its model files, the
// node classes ComfyUI loads it with and good defaults per variant, all taken from ComfyUI's own
// workflow templates (`Comfy-Org/workflow_templates`: `image_krea2_turbo_t2i`,
// `image_moss_image_t2i`, `image_anima_base_v1`). Every file name and default can be changed in
// `[modules.imagegen.models.<id>]`, and the service checks the files are in ComfyUI before it
// queues anything, so a wrong name is a clear error rather than a failed run.
//
// One graph shape covers all three: loaders → LoRAs → (MOSS: skip-layer guidance) → prompts →
// an empty latent, or the start picture encoded (image to image) → KSampler → VAEDecode →
// SaveImage. Krea 2 has no negative prompt: its negative is the positive zeroed out, as in the
// template.

import type { ImageLora, ImageRequest } from "@miyoria/types";
import type { ComfyGraph } from "./comfy.js";
import { GraphBuilder, type Link } from "./graph.js";

/** The three files every adapter loads, by ComfyUI folder. */
export interface ModelFiles {
  diffusion_model: string;
  text_encoder: string;
  vae: string;
}

/** Sampling defaults of one variant, and the files it changes. */
export interface Variant {
  files: Partial<ModelFiles>;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** LoRAs the variant itself needs (Anima Turbo is a LoRA on Anima Base). */
  loras: ImageLora[];
}

export type LatentNode = "EmptyLatentImage" | "EmptyFlux2LatentImage";

export interface ModelAdapter {
  id: string;
  label: string;
  /** `CLIPLoader`'s `type`. */
  clip_type: string;
  files: ModelFiles;
  variants: Record<string, Variant>;
  default_variant: string;
  latent: LatentNode;
  width: number;
  height: number;
  /** Width and height are rounded to a multiple of this. */
  size_step: number;
  min_side: number;
  max_side: number;
  uses_negative: boolean;
  /** The negative used when a request gives none (`""`: an empty negative). */
  default_negative: string;
  /** Put in front of every prompt (Anima's quality tags, when set). */
  prompt_prefix: string;
  /** MOSS-Image: skip-layer guidance on the uncond pass, as the template can switch on. */
  slg: { single_layers: string; double_layers: string; start: number; end: number } | null;
  prompt_hint: string;
  license: string;
}

export const KREA2: ModelAdapter = {
  id: "krea2",
  label: "Krea 2",
  clip_type: "krea2",
  files: {
    diffusion_model: "krea2_turbo_fp8_scaled.safetensors",
    text_encoder: "qwen3vl_4b_fp8_scaled.safetensors",
    vae: "qwen_image_vae.safetensors",
  },
  variants: {
    turbo: { files: {}, steps: 8, cfg: 1, sampler: "euler", scheduler: "simple", loras: [] },
    // The undistilled base: for training LoRAs and slow, rich pictures. Its file is not in the
    // Turbo template; set `variants.raw.files.diffusion_model` to the file you downloaded.
    raw: {
      files: { diffusion_model: "krea2_raw_fp8_scaled.safetensors" },
      steps: 52,
      cfg: 3.5,
      sampler: "euler",
      scheduler: "simple",
      loras: [],
    },
  },
  default_variant: "turbo",
  latent: "EmptyLatentImage",
  width: 1024,
  height: 1024,
  size_step: 8,
  min_side: 256,
  max_side: 2048,
  uses_negative: false,
  default_negative: "",
  prompt_prefix: "",
  slg: null,
  prompt_hint:
    "Natural-language description of the finished picture (subject, setting, light, style). " +
    "No negative prompt. Turbo goes from 1K to 2K; style LoRAs take their trigger words.",
  license: "Krea 2 Community License (commercial use only under its revenue threshold)",
};

export const MOSS_IMAGE: ModelAdapter = {
  id: "moss_image",
  label: "MOSS-Image",
  clip_type: "moss_image",
  files: {
    diffusion_model: "moss_image_sft_int8_convrot.safetensors",
    text_encoder: "qwen3.5_9b_w4a8_gptq.safetensors",
    vae: "flux2-vae_small.safetensors",
  },
  variants: {
    sft: { files: {}, steps: 25, cfg: 2.5, sampler: "er_sde", scheduler: "simple", loras: [] },
    base: {
      files: { diffusion_model: "moss_image_base_int8_convrot.safetensors" },
      steps: 50,
      cfg: 3,
      sampler: "euler",
      scheduler: "simple",
      loras: [],
    },
  },
  default_variant: "sft",
  latent: "EmptyFlux2LatentImage",
  width: 1024,
  height: 1024,
  size_step: 16,
  min_side: 512,
  max_side: 2048,
  uses_negative: true,
  default_negative: "",
  prompt_prefix: "",
  slg: null,
  prompt_hint:
    "Caption-style description of the finished picture; renders text in the picture well. " +
    "About 1 to 2 megapixels, sides a multiple of 16. Base also takes Danbooru-style tags.",
  license: "Apache-2.0",
};

export const ANIMA: ModelAdapter = {
  id: "anima",
  label: "Anima",
  clip_type: "stable_diffusion",
  files: {
    diffusion_model: "anima-base-v1.0.safetensors",
    text_encoder: "qwen_3_06b_base.safetensors",
    vae: "qwen_image_vae.safetensors",
  },
  variants: {
    base: { files: {}, steps: 30, cfg: 4, sampler: "euler", scheduler: "simple", loras: [] },
    turbo: {
      files: {},
      steps: 8,
      cfg: 1,
      sampler: "euler",
      scheduler: "simple",
      loras: [{ name: "anima-turbo-lora-v0.2.safetensors", strength: 1 }],
    },
  },
  default_variant: "base",
  latent: "EmptyLatentImage",
  width: 1024,
  height: 1024,
  size_step: 16,
  min_side: 512,
  max_side: 1536,
  uses_negative: true,
  default_negative:
    "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia",
  prompt_prefix: "",
  slg: null,
  prompt_hint:
    "Anime illustration. Danbooru tags (lowercase, spaces not underscores) plus natural language, " +
    "in the order quality, 1girl, character, series, @artist, general tags; e.g. " +
    "'masterpiece, best quality, score_7, safe, 1girl, ...'. 512 to 1536 per side.",
  license: "CircleStone Labs non-commercial license (pictures may be used commercially)",
};

export const BUILTIN_MODELS: readonly ModelAdapter[] = [KREA2, MOSS_IMAGE, ANIMA];

/** Rounds `n` to the nearest multiple of `step` inside `[min, max]`. */
export function snap(n: number, step: number, min: number, max: number): number {
  const r = Math.round(n / step) * step;
  return Math.min(Math.max(r, Math.ceil(min / step) * step), Math.floor(max / step) * step);
}

/** The files a variant loads. */
export function variantFiles(model: ModelAdapter, variant: string): ModelFiles {
  return { ...model.files, ...(model.variants[variant]?.files ?? {}) };
}

/** What `buildModelGraph` needs besides the resolved request. */
export interface BuildOptions {
  /** `SaveImage`'s `filename_prefix`. */
  prefix: string;
  /** The `LoadImage` name of the uploaded start picture (image to image). */
  initImage: string | null;
}

/**
 * The graph for a resolved request (`request.model` is `model.id`; every sampling field is set).
 * Returns the graph and the id of its `SaveImage` node.
 */
export function buildModelGraph(
  model: ModelAdapter,
  request: ImageRequest,
  options: BuildOptions,
): { graph: ComfyGraph; save: string } {
  const variant = request.variant ?? model.default_variant;
  const files = variantFiles(model, variant);
  const g = new GraphBuilder();
  const unet = g.add("UNETLoader", { unet_name: files.diffusion_model, weight_dtype: "default" });
  const clip = g.add("CLIPLoader", {
    clip_name: files.text_encoder,
    type: model.clip_type,
    device: "default",
  });
  const vae = g.add("VAELoader", { vae_name: files.vae });

  let modelOut: Link = g.out(unet);
  const loras = [...(model.variants[variant]?.loras ?? []), ...request.loras];
  for (const lora of loras) {
    const id = g.add("LoraLoaderModelOnly", {
      model: modelOut,
      lora_name: lora.name,
      strength_model: lora.strength,
    });
    modelOut = g.out(id);
  }
  if (model.slg) {
    const id = g.add("SkipLayerGuidanceDiTSimple", {
      model: modelOut,
      double_layers: model.slg.double_layers,
      single_layers: model.slg.single_layers,
      start_percent: model.slg.start,
      end_percent: model.slg.end,
    });
    modelOut = g.out(id);
  }

  const text = model.prompt_prefix ? `${model.prompt_prefix}${request.prompt}` : request.prompt;
  const positive = g.add("CLIPTextEncode", { text, clip: g.out(clip) }, "Positive Prompt");
  const negative = model.uses_negative
    ? g.add(
        "CLIPTextEncode",
        { text: request.negative ?? model.default_negative, clip: g.out(clip) },
        "Negative Prompt",
      )
    : g.add("ConditioningZeroOut", { conditioning: g.out(positive) });

  const width = request.width ?? model.width;
  const height = request.height ?? model.height;
  let latent: Link;
  if (options.initImage !== null) {
    const load = g.add("LoadImage", { image: options.initImage }, "Start Picture");
    const encoded = g.add("VAEEncode", { pixels: g.out(load), vae: g.out(vae) });
    latent = g.out(encoded);
    if (request.batch > 1) {
      latent = g.out(g.add("RepeatLatentBatch", { samples: latent, amount: request.batch }));
    }
  } else {
    latent = g.out(g.add(model.latent, { width, height, batch_size: request.batch }));
  }

  const sampler = g.add("KSampler", {
    model: modelOut,
    positive: g.out(positive),
    negative: g.out(negative),
    latent_image: latent,
    seed: request.seed ?? 0,
    steps: request.steps ?? 20,
    cfg: request.cfg ?? 1,
    sampler_name: request.sampler ?? "euler",
    scheduler: request.scheduler ?? "simple",
    denoise: options.initImage !== null ? (request.denoise ?? 0.6) : 1,
  });
  const decoded = g.add("VAEDecode", { samples: g.out(sampler), vae: g.out(vae) });
  const save = g.add("SaveImage", { images: g.out(decoded), filename_prefix: options.prefix });
  return { graph: g.build(), save };
}
