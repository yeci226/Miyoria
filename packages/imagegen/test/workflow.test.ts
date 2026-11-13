import { describe, expect, it } from "vitest";
import type { ComfyGraph } from "../src/comfy.js";
import { detectParams, fillWorkflow, parseWorkflow, WorkflowError } from "../src/workflow.js";

/** A bare "Export (API)" graph, as ComfyUI writes it. */
const EXPORT: ComfyGraph = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 1,
      steps: 20,
      cfg: 4,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "4": {
    class_type: "UNETLoader",
    inputs: { unet_name: "a.safetensors", weight_dtype: "default" },
  },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: "cat", clip: ["8", 0] },
    _meta: { title: "Positive" },
  },
  "7": {
    class_type: "CLIPTextEncode",
    inputs: { text: "ugly", clip: ["8", 0] },
    _meta: { title: "Negative" },
  },
  "9": { class_type: "SaveImage", inputs: { images: ["10", 0], filename_prefix: "ComfyUI" } },
};

describe("workflow files", () => {
  it("finds the usual parameters of a bare export", () => {
    const params = detectParams(EXPORT);
    expect(Object.keys(params).sort()).toEqual(
      [
        "batch",
        "cfg",
        "denoise",
        "height",
        "negative",
        "prompt",
        "sampler",
        "scheduler",
        "seed",
        "steps",
        "width",
      ].sort(),
    );
    const wf = parseWorkflow("bare", EXPORT);
    expect(wf.outputs).toEqual(["9"]);
    const graph = fillWorkflow(wf, { prompt: "whale", seed: 7, width: 768 });
    expect(graph["6"]?.inputs.text).toBe("whale");
    expect(graph["3"]?.inputs.seed).toBe(7);
    expect(graph["5"]?.inputs.width).toBe(768);
    expect(graph["7"]?.inputs.text).toBe("ugly"); // left as exported
    expect(EXPORT["6"]?.inputs.text).toBe("cat"); // the file's graph is not changed
  });

  it("binds declared parameters by node title, to several targets, with checks", () => {
    const wf = parseWorkflow("declared", {
      description: "two prompts",
      params: {
        prompt: {
          targets: [
            { node: "Positive", input: "text" },
            { node: "Negative", input: "text" },
          ],
          required: true,
        },
        steps: { node: "3", input: "steps", type: "int", min: 1, max: 50, default: 12 },
        mood: { node: "3", input: "scheduler", type: "enum", options: ["simple", "karras"] },
      },
      graph: EXPORT,
    });
    const g = fillWorkflow(wf, { prompt: "sea" });
    expect(g["6"]?.inputs.text).toBe("sea");
    expect(g["7"]?.inputs.text).toBe("sea");
    expect(g["3"]?.inputs.steps).toBe(12);
    expect(() => fillWorkflow(wf, {})).toThrow(/required/);
    expect(() => fillWorkflow(wf, { prompt: "a", steps: 99 })).toThrow(/above 50/);
    expect(() => fillWorkflow(wf, { prompt: "a", mood: "x" })).toThrow(/one of/);
    expect(() => fillWorkflow(wf, { prompt: "a", nope: 1 })).toThrow(/no parameter/);
  });

  it("refuses the editor's format and bindings to nodes that do not exist", () => {
    expect(() => parseWorkflow("ui", { nodes: [], links: [] })).toThrow(/Export \(API\)/);
    expect(() =>
      parseWorkflow("bad", { params: { prompt: { node: "Nope", input: "text" } }, graph: EXPORT }),
    ).toThrow(WorkflowError);
    expect(() =>
      parseWorkflow("nosave", { "1": { class_type: "UNETLoader", inputs: {} } }),
    ).toThrow(/SaveImage/);
  });
});
