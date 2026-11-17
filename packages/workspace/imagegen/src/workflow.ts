// Workflow files: a graph made in ComfyUI's editor and exported with "Export (API)", plus which
// of its inputs are parameters. The owner changes models, adds upscalers or ControlNets in the
// editor; the code only fills in the declared parameters and never touches another node.
//
// `<workflows_dir>/<id>.json` is either
//
//   { "description": "...", "params": { "<name>": <binding>, ... }, "outputs": ["9"], "graph": {...} }
//
// or the bare API export, whose parameters are then found by convention (below). A binding is
// `{ "node": "<id or title>", "input": "<input name>", "type": "string", "default": ... }` or
// `{ "targets": [{ "node", "input" }, ...], "type": ... }` for a value set in several places.
// `node` matches a node's id or its title (`_meta.title`, the name shown in the editor).
//
// Types: `string`, `int`, `float`, `bool`, `seed` (an int; random when not given), `image` (a
// picture to upload: the module uploads the file and sets the name `LoadImage` takes) and
// `enum` (one of `options`).

import type { JsonValue } from "@miyoria/types";
import { z } from "zod";
import type { ComfyGraph, ComfyNode } from "./comfy.js";
import { saveNodes } from "./graph.js";

export class WorkflowError extends Error {
  override readonly name = "WorkflowError";
}

const TargetSchema = z.object({ node: z.string().min(1), input: z.string().min(1) });

const ParamSchema = z
  .object({
    node: z.string().min(1).optional(),
    input: z.string().min(1).optional(),
    targets: z.array(TargetSchema).min(1).optional(),
    type: z.enum(["string", "int", "float", "bool", "seed", "image", "enum"]).default("string"),
    default: z.json().optional(),
    required: z.boolean().default(false),
    min: z.number().optional(),
    max: z.number().optional(),
    options: z.array(z.string()).optional(),
    description: z.string().optional(),
  })
  .refine((p) => p.targets !== undefined || (p.node !== undefined && p.input !== undefined), {
    message: "a parameter needs `node` and `input`, or `targets`",
  });
export type WorkflowParam = z.output<typeof ParamSchema>;

const NodeSchema = z.looseObject({
  class_type: z.string().min(1),
  inputs: z.record(z.string(), z.json()).default({}),
  _meta: z.looseObject({ title: z.string().optional() }).optional(),
});

const GraphSchema = z.record(z.string(), NodeSchema);

const FileSchema = z.object({
  description: z.string().default(""),
  params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), ParamSchema),
  outputs: z.array(z.string()).optional(),
  graph: GraphSchema,
});

export interface Workflow {
  id: string;
  description: string;
  params: Record<string, WorkflowParam>;
  /** Node ids whose saved pictures are the job's outputs. */
  outputs: string[];
  graph: ComfyGraph;
}

/** The node a binding names: by id first, then by title (which must then be unique). */
function resolveNode(graph: ComfyGraph, ref: string): string {
  if (graph[ref] !== undefined) return ref;
  const byTitle = Object.entries(graph).filter(([, n]) => n._meta?.title === ref);
  if (byTitle.length === 1) return (byTitle[0] as [string, ComfyNode])[0];
  if (byTitle.length > 1) throw new WorkflowError(`more than one node is titled \`${ref}\``);
  throw new WorkflowError(`no node \`${ref}\` (by id or title)`);
}

/** A node input is a link when it is `["<id>", <slot>]`. */
function isLink(value: JsonValue | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}

/**
 * Parameters of a bare API export, by convention: the text of the node titled like "positive"
 * (else the first `CLIPTextEncode`) is `prompt`, one titled like "negative" is `negative`; the
 * first `KSampler`'s `seed`, `steps`, `cfg`, `sampler_name`, `scheduler`, `denoise`; the first
 * empty latent's `width`, `height`, `batch_size`; the first `LoadImage`'s `image`. Only inputs
 * that hold a value (not a link) become parameters.
 */
export function detectParams(graph: ComfyGraph): Record<string, WorkflowParam> {
  const params: Record<string, WorkflowParam> = {};
  const ids = Object.keys(graph).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const first = (pred: (n: ComfyNode) => boolean) => ids.find((id) => pred(graph[id] as ComfyNode));
  const bind = (
    name: string,
    node: string | undefined,
    input: string,
    type: WorkflowParam["type"],
  ) => {
    if (node === undefined) return;
    const value = graph[node]?.inputs[input];
    if (value === undefined || isLink(value)) return;
    params[name] = { node, input, type, required: false };
  };
  const title = (n: ComfyNode) => (n._meta?.title ?? "").toLowerCase();
  const encoders = (n: ComfyNode) => n.class_type === "CLIPTextEncode";
  const pos =
    first((n) => encoders(n) && title(n).includes("positive")) ??
    first((n) => encoders(n) && !title(n).includes("negative"));
  bind("prompt", pos, "text", "string");
  bind(
    "negative",
    first((n) => encoders(n) && title(n).includes("negative")),
    "text",
    "string",
  );
  const sampler = first((n) => n.class_type === "KSampler" || n.class_type === "KSamplerAdvanced");
  if (sampler !== undefined) {
    const seedInput = graph[sampler]?.inputs.noise_seed !== undefined ? "noise_seed" : "seed";
    bind("seed", sampler, seedInput, "seed");
    bind("steps", sampler, "steps", "int");
    bind("cfg", sampler, "cfg", "float");
    bind("sampler", sampler, "sampler_name", "string");
    bind("scheduler", sampler, "scheduler", "string");
    bind("denoise", sampler, "denoise", "float");
  }
  const latent = first((n) => /^Empty.*Latent/.test(n.class_type));
  bind("width", latent, "width", "int");
  bind("height", latent, "height", "int");
  bind("batch", latent, "batch_size", "int");
  bind(
    "image",
    first((n) => n.class_type === "LoadImage"),
    "image",
    "image",
  );
  return params;
}

/** Parses a workflow file's JSON (`id` is its file name without `.json`). */
export function parseWorkflow(id: string, raw: unknown): Workflow {
  if (
    raw !== null &&
    typeof raw === "object" &&
    Array.isArray((raw as { nodes?: unknown }).nodes)
  ) {
    throw new WorkflowError(
      `workflow \`${id}\` is in the editor's format; export it with "Export (API)" instead`,
    );
  }
  let parsed: z.output<typeof FileSchema>;
  if (raw !== null && typeof raw === "object" && "graph" in raw) {
    const file = FileSchema.safeParse(raw);
    if (!file.success) {
      throw new WorkflowError(`workflow \`${id}\`: ${z.prettifyError(file.error)}`);
    }
    parsed = file.data;
  } else {
    const graph = GraphSchema.safeParse(raw);
    if (!graph.success) {
      throw new WorkflowError(`workflow \`${id}\` is not a ComfyUI API graph`);
    }
    parsed = { description: "", params: detectParams(graph.data as ComfyGraph), graph: graph.data };
  }
  const graph = parsed.graph as ComfyGraph;
  // Bindings resolve now, so a broken file fails when it is read, not when a job runs.
  const params: Record<string, WorkflowParam> = {};
  for (const [name, p] of Object.entries(parsed.params)) {
    const targets = (p.targets ?? [{ node: p.node as string, input: p.input as string }]).map(
      (t) => ({ node: resolveNode(graph, t.node), input: t.input }),
    );
    if (p.type === "enum" && (p.options === undefined || p.options.length === 0)) {
      throw new WorkflowError(`workflow \`${id}\`: enum parameter \`${name}\` has no options`);
    }
    params[name] = { ...p, targets, node: undefined, input: undefined };
  }
  const outputs = (parsed.outputs ?? saveNodes(graph)).map((o) => resolveNode(graph, o));
  if (outputs.length === 0) {
    throw new WorkflowError(`workflow \`${id}\` has no SaveImage node and names no outputs`);
  }
  return { id, description: parsed.description, params, outputs, graph };
}

/** One parameter's value checked against its binding. */
function checkValue(name: string, p: WorkflowParam, value: JsonValue): JsonValue {
  switch (p.type) {
    case "string":
    case "image":
      if (typeof value !== "string") throw new WorkflowError(`\`${name}\` must be a string`);
      return value;
    case "bool":
      if (typeof value !== "boolean") throw new WorkflowError(`\`${name}\` must be true or false`);
      return value;
    case "enum":
      if (typeof value !== "string" || !(p.options ?? []).includes(value)) {
        throw new WorkflowError(`\`${name}\` must be one of ${(p.options ?? []).join(", ")}`);
      }
      return value;
    case "int":
    case "seed":
    case "float": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new WorkflowError(`\`${name}\` must be a number`);
      }
      if (p.type !== "float" && !Number.isInteger(value)) {
        throw new WorkflowError(`\`${name}\` must be a whole number`);
      }
      if (p.min !== undefined && value < p.min)
        throw new WorkflowError(`\`${name}\` is below ${p.min}`);
      if (p.max !== undefined && value > p.max)
        throw new WorkflowError(`\`${name}\` is above ${p.max}`);
      return value;
    }
  }
}

/**
 * The workflow's graph with `values` set (names the workflow does not declare are an error, a
 * declared one left out keeps the graph's value or the binding's `default`). Image parameters
 * must already hold the name ComfyUI knows the uploaded picture by.
 */
export function fillWorkflow(workflow: Workflow, values: Record<string, JsonValue>): ComfyGraph {
  const graph = structuredClone(workflow.graph);
  for (const name of Object.keys(values)) {
    if (workflow.params[name] === undefined) {
      throw new WorkflowError(`workflow \`${workflow.id}\` has no parameter \`${name}\``);
    }
  }
  for (const [name, p] of Object.entries(workflow.params)) {
    const given = values[name];
    const value = given !== undefined ? given : p.default;
    if (value === undefined) {
      if (p.required) throw new WorkflowError(`\`${name}\` is required`);
      continue;
    }
    const checked = checkValue(name, p, value);
    for (const t of p.targets ?? []) {
      const node = graph[t.node] as ComfyNode;
      node.inputs[t.input] = checked;
    }
  }
  return graph;
}
