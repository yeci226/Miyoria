import type { ImageRequest } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import type { ComfyGraph } from "../src/comfy.js";
import { ANIMA, buildModelGraph, KREA2, MOSS_IMAGE, snap } from "../src/models.js";

const request = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  model: "krea2",
  variant: null,
  workflow: null,
  prompt: "a whale girl reading in a deep-sea library",
  negative: null,
  width: 1024,
  height: 1024,
  seed: 42,
  steps: 8,
  cfg: 1,
  sampler: "euler",
  scheduler: "simple",
  batch: 1,
  loras: [],
  init_image: null,
  denoise: null,
  params: {},
  ...over,
});

const byClass = (graph: ComfyGraph, cls: string) =>
  Object.entries(graph).filter(([, n]) => n.class_type === cls);
const one = (graph: ComfyGraph, cls: string) => {
  const found = byClass(graph, cls);
  expect(found).toHaveLength(1);
  return (found[0] as [string, ComfyGraph[string]])[1];
};

describe("built-in model graphs", () => {
  it("Krea 2 Turbo follows the template: krea2 text encoder, zeroed negative, 8 steps", () => {
    const { graph, save } = buildModelGraph(KREA2, request(), { prefix: "x/y", initImage: null });
    expect(one(graph, "UNETLoader").inputs.unet_name).toBe("krea2_turbo_fp8_scaled.safetensors");
    expect(one(graph, "CLIPLoader").inputs).toMatchObject({
      clip_name: "qwen3vl_4b_fp8_scaled.safetensors",
      type: "krea2",
    });
    expect(one(graph, "VAELoader").inputs.vae_name).toBe("qwen_image_vae.safetensors");
    expect(byClass(graph, "CLIPTextEncode")).toHaveLength(1);
    const zero = byClass(graph, "ConditioningZeroOut")[0]?.[0];
    const sampler = one(graph, "KSampler");
    expect(sampler.inputs).toMatchObject({ steps: 8, cfg: 1, seed: 42, denoise: 1 });
    expect(sampler.inputs.negative).toEqual([zero, 0]);
    expect(one(graph, "EmptyLatentImage").inputs).toEqual({
      width: 1024,
      height: 1024,
      batch_size: 1,
    });
    expect(graph[save]?.class_type).toBe("SaveImage");
    expect(graph[save]?.inputs.filename_prefix).toBe("x/y");
  });

  it("MOSS-Image uses its own latent, text encoder type and a negative prompt", () => {
    const { graph } = buildModelGraph(
      MOSS_IMAGE,
      request({ model: "moss_image", negative: "blurry", steps: 25, cfg: 2.5, sampler: "er_sde" }),
      { prefix: "p", initImage: null },
    );
    expect(one(graph, "CLIPLoader").inputs.type).toBe("moss_image");
    expect(one(graph, "EmptyFlux2LatentImage").inputs.width).toBe(1024);
    const texts = byClass(graph, "CLIPTextEncode").map(([, n]) => n.inputs.text);
    expect(texts).toContain("blurry");
    expect(byClass(graph, "SkipLayerGuidanceDiTSimple")).toHaveLength(0);
    const withSlg = buildModelGraph(
      { ...MOSS_IMAGE, slg: { single_layers: "22", double_layers: "", start: 0, end: 0.5 } },
      request({ model: "moss_image" }),
      { prefix: "p", initImage: null },
    ).graph;
    expect(one(withSlg, "SkipLayerGuidanceDiTSimple").inputs.single_layers).toBe("22");
  });

  it("Anima Turbo is the base model with the turbo LoRA, then the request's own LoRAs", () => {
    const { graph } = buildModelGraph(
      ANIMA,
      request({
        model: "anima",
        variant: "turbo",
        loras: [{ name: "her.safetensors", strength: 0.8 }],
      }),
      { prefix: "p", initImage: null },
    );
    const loras = byClass(graph, "LoraLoaderModelOnly").map(([id, n]) => [id, n.inputs]);
    expect(loras.map(([, i]) => (i as Record<string, unknown>).lora_name)).toEqual([
      "anima-turbo-lora-v0.2.safetensors",
      "her.safetensors",
    ]);
    // chained: the second takes the first's model, the sampler takes the last
    const [first, second] = loras as [
      [string, Record<string, unknown>],
      [string, Record<string, unknown>],
    ];
    expect(second[1].model).toEqual([first[0], 0]);
    expect(one(graph, "KSampler").inputs.model).toEqual([second[0], 0]);
    expect(one(graph, "CLIPLoader").inputs.type).toBe("stable_diffusion");
    const negative = byClass(graph, "CLIPTextEncode").find(
      ([, n]) => n._meta?.title === "Negative Prompt",
    );
    expect(negative?.[1].inputs.text).toBe(ANIMA.default_negative);
  });

  it("image to image encodes the start picture and redraws only part of it", () => {
    const { graph } = buildModelGraph(KREA2, request({ batch: 2, denoise: 0.45 }), {
      prefix: "p",
      initImage: "miyoria/start.png",
    });
    expect(one(graph, "LoadImage").inputs.image).toBe("miyoria/start.png");
    expect(byClass(graph, "VAEEncode")).toHaveLength(1);
    expect(one(graph, "RepeatLatentBatch").inputs.amount).toBe(2);
    expect(byClass(graph, "EmptyLatentImage")).toHaveLength(0);
    expect(one(graph, "KSampler").inputs.denoise).toBe(0.45);
  });

  it("snaps sizes to the model's step and range", () => {
    expect(snap(1000, 16, 512, 2048)).toBe(1008);
    expect(snap(100, 16, 512, 2048)).toBe(512);
    expect(snap(5000, 8, 256, 2048)).toBe(2048);
  });
});
